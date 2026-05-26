// BridgeConnectionCard — the persistent "how to run this bridge" surface.
//
// Three deployment shapes, in operator preference order:
//
//   1. Docker + Tailscale (DEFAULT). The bridge runs inside a
//      Tailscale sidecar's network namespace (`network_mode:
//      service:tailscale`). Tailnet members reach the bridge by
//      MagicDNS at `<bridge>-mail`, and sister services on the same
//      compose project reach it by docker DNS at `polaris-mail`
//      (the TS sidecar's container_name). Cert: the bridge mints its
//      own via embedded ACME using the per-bridge CF DNS token
//      fetched from `/v1/bridge/config` — no Lego sidecar needed.
//      Auth key: a bootstrap init container HMAC-fetches the per-
//      bridge tailnet auth key and writes it to ./secrets/ts_authkey
//      before TS starts — nothing operator-procured.
//
//   2. Docker (public host). Bridge binds host ports directly.
//      Suitable when the host is already publicly reachable. No TS
//      sidecar. Same embedded-ACME cert path.
//
//   3. Bare metal (systemd). For operators who already manage their
//      own host (PEMs / unit files / etc.).
//
// All three use `docker-compose.env` as the env-file (operator
// convention). All three carry the bridge_id + hmac_key in a
// `./secrets/` directory mounted via `*_FILE` indirection — the HMAC
// key is the one true bootstrap secret and never appears in compose
// or env files.
//
// What's NOT here anymore:
//   * Lego sidecar. The bridge embeds ACME (see
//     `apps/mail-bridge/internal/acme/`) and fetches its CF DNS token
//     from `/v1/bridge/config` on startup. No `CF_DNS_API_TOKEN` in
//     the operator's `.env` either.
//   * `BRIDGE_FQDN` / `ACME_EMAIL`. Same story — the bridge gets
//     these from the api.
//   * `BRIDGE_ACCESS_CLIENT_ID/SECRET`. The polaris API isn't behind
//     CF Access (see project memory); HMAC is the only auth surface.
import { CodeBlock } from '../../components/CodeBlock.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';

interface BridgeConnectionCardProps {
  bridgeId: string;
  bridgeName: string;
  // Optional: the just-minted plaintext HMAC key + install URL from
  // the post-registration fresh-secrets bundle. Seeds the card so the
  // operator can run the curl line immediately without re-rotating.
  // Once cleared, "Generate install URL" rotates the HMAC to mint a
  // fresh pair — the only way to produce a working install URL.
  initialHmacKey?: string;
  initialInstallerUrl?: string;
}

const HMAC_PLACEHOLDER = '<paste-HMAC-key-here>';
const API_URL = 'https://api.mail.plrs.im';
const IMAGE = 'ghcr.io/vladzaharia/polaris-mail-bridge:latest';

function fqdnFor(bridgeName: string): string {
  return `${bridgeName}.mail.plrs.im`;
}

// Tailscale MagicDNS doesn't allow dots; the convention is
// `<bridge>-mail`. Sister services on the tailnet reach the bridge at
// this name; the FQDN above is the public CNAME pointing to the same
// tailnet node, so the LE cert (issued for the FQDN) is valid for
// both reachability paths.
function tailnetHostnameFor(bridgeName: string): string {
  return `${bridgeName}-mail`;
}

// ---------- snippet templates ----------

// Default deployment: TS sidecar + embedded ACME bridge.
//
// Network model:
//   - TS container holds the tailnet identity. Other services on the
//     SAME compose project's `polaris-mail-net` reach the bridge via
//     `polaris-mail:465/993` (docker DNS to the TS container's
//     namespace, where the bridge listens). Tailnet members reach it
//     via MagicDNS `<bridge>-mail`.
//   - Bridge runs `network_mode: service:tailscale` so its listeners
//     are bound on the TS container's interfaces (tailnet + the docker
//     network alias).
//   - No host ports published — the bridge isn't directly reachable
//     from the host's external interface.
function composeTailscale(bridgeName: string): string {
  const tsHost = tailnetHostnameFor(bridgeName);
  return `# docker-compose.yml — bridge + Tailscale sidecar (DEFAULT)
#
#   docker compose up -d
#
# Other services on this compose project reach the bridge via
#   polaris-mail:465  (SMTPS)
#   polaris-mail:993  (IMAP)
# Tailnet members resolve \`${tsHost}\` (MagicDNS) to the same node.
#
# Bootstrap init: a short-lived sibling container fetches the per-
# bridge Tailscale auth key from the polaris API (HMAC-authed) and
# writes it to ./secrets/ts_authkey before the TS sidecar starts.
# Operators never handle the TS auth key themselves; only
# ./secrets/bridge_id + ./secrets/hmac_key need to exist before
# compose up.
networks:
  polaris-mail-net:
    driver: bridge

services:
  bootstrap:
    image: ${IMAGE}
    container_name: polaris-mail-bootstrap
    command: ['polaris-bridge', 'bootstrap-tailscale']
    env_file: docker-compose.env
    environment:
      BRIDGE_POLARIS_BRIDGE_ID_FILE: /run/secrets/bridge_id
      BRIDGE_POLARIS_HMAC_KEY_FILE: /run/secrets/hmac_key
      TS_AUTHKEY_PATH: /run/secrets/ts_authkey
    volumes:
      - ./secrets:/run/secrets

  tailscale:
    image: tailscale/tailscale:stable
    container_name: polaris-mail
    hostname: ${tsHost}
    restart: unless-stopped
    networks: [polaris-mail-net]
    cap_add: [NET_ADMIN, NET_RAW]
    devices: ['/dev/net/tun:/dev/net/tun']
    environment:
      TS_STATE_DIR: /var/lib/tailscale
      TS_USERSPACE: 'false'
      TS_EXTRA_ARGS: --advertise-tags=tag:mail-bridge
      TS_AUTHKEY_FILE: /run/secrets/ts_authkey
    volumes:
      - ts-state:/var/lib/tailscale
      - ./secrets:/run/secrets:ro
    depends_on:
      bootstrap:
        condition: service_completed_successfully

  bridge:
    image: ${IMAGE}
    container_name: polaris-mail-bridge
    restart: unless-stopped
    network_mode: 'service:tailscale'
    depends_on:
      - tailscale
    env_file: docker-compose.env
    environment:
      BRIDGE_POLARIS_BRIDGE_ID_FILE: /run/secrets/bridge_id
      BRIDGE_POLARIS_HMAC_KEY_FILE: /run/secrets/hmac_key
    volumes:
      - ./secrets:/run/secrets:ro
      - bridge-certs:/var/lib/polaris-bridge/certs
      - bridge-data:/var/lib/polaris-bridge
      - bridge-logs:/var/log/polaris-bridge

volumes:
  ts-state:
  bridge-certs:
  bridge-data:
  bridge-logs:
`;
}

// Public-host deployment: no TS, bridge binds host network ports.
function composePublic(bridgeName: string): string {
  return `# docker-compose.yml — bridge on public host (no Tailscale)
#
#   docker compose up -d
#
# The bridge binds :465 / :993 / :8080 on the host network. Operator
# owns the firewall + an A record for ${fqdnFor(bridgeName)} pointing
# at this host's public IP.
services:
  bridge:
    image: ${IMAGE}
    container_name: polaris-mail-bridge
    restart: unless-stopped
    network_mode: host
    env_file: docker-compose.env
    environment:
      BRIDGE_POLARIS_BRIDGE_ID_FILE: /run/secrets/bridge_id
      BRIDGE_POLARIS_HMAC_KEY_FILE: /run/secrets/hmac_key
    volumes:
      - ./secrets:/run/secrets:ro
      - bridge-certs:/var/lib/polaris-bridge/certs
      - bridge-data:/var/lib/polaris-bridge
      - bridge-logs:/var/log/polaris-bridge

volumes:
  bridge-certs:
  bridge-data:
  bridge-logs:
`;
}

function envCompanion(bridgeName: string): string {
  return `# docker-compose.env — referenced by docker-compose.yml via env_file.
# No secrets in here; the HMAC key + bridge id (and TS auth key) live
# as files under ./secrets/ that the bridge reads via *_FILE env vars.

BRIDGE_NAME=${bridgeName}
BRIDGE_POLARIS_API_URL=${API_URL}
`;
}

function secretsShell(bridgeId: string, hmacKey: string, _withTailscale: boolean): string {
  // Only TWO secrets need to exist on the bridge host before
  // `docker compose up`: the bridge id (identifier) and the HMAC key
  // (the one true bootstrap secret). Everything else — CF DNS token,
  // ACME state, the TS auth key — flows over the wire from the
  // polaris API. The Tailscale tab uses a bootstrap init container
  // that fetches `ts_authkey` and writes it before the TS sidecar
  // starts; nothing for the operator to copy.
  return `# Run once on the bridge host.
mkdir -p secrets
echo -n '${bridgeId}' > secrets/bridge_id
echo -n '${hmacKey}' > secrets/hmac_key
chmod 600 secrets/*
`;
}

function systemdUnit(bridgeName: string): string {
  return `# /etc/systemd/system/polaris-mail-bridge.service
# Bare-metal install. Pair with /etc/polaris-bridge/bridge.env.
[Unit]
Description=Polaris Mail Bridge (${bridgeName})
Documentation=https://docs.mail.plrs.im/operators/bridges
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=polaris-bridge
Group=polaris-bridge
ExecStart=/usr/local/bin/polaris-mail-bridge
EnvironmentFile=/etc/polaris-bridge/bridge.env
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/polaris-bridge /var/log/polaris-bridge

[Install]
WantedBy=multi-user.target
`;
}

function bareMetalEnv(bridgeName: string, hmacKey: string): string {
  return `# /etc/polaris-bridge/bridge.env  (mode 0600, owned by polaris-bridge)
# Contains the HMAC key — treat as a secret. The CF DNS token, FQDN,
# and ACME email come from the polaris API at startup; not in here.

BRIDGE_NAME=${bridgeName}
BRIDGE_POLARIS_API_URL=${API_URL}
BRIDGE_POLARIS_BRIDGE_ID=01H...                  # bridge ULID from registration
BRIDGE_POLARIS_HMAC_KEY=${hmacKey}

# Cert dir owned by the bridge's embedded ACME loop; PEMs land here.
BRIDGE_TLS_CERT_DIR=/var/lib/polaris-bridge/certs

# Local state.
BRIDGE_CREDSTORE_PATH=/var/lib/polaris-bridge/credstore.db
BRIDGE_MIRROR_PATH=/var/lib/polaris-bridge/mirror.db
BRIDGE_LOGGING_FILE=/var/log/polaris-bridge/audit.jsonl

# Optional. Pin the IP the bridge writes into its own CF A record;
# defaults to the first non-loopback IPv4 interface.
# BRIDGE_PUBLIC_IP=10.0.0.42
`;
}

// ---------- env-var reference table ----------

interface EnvVarReference {
  name: string;
  required: boolean;
  description: string;
}

const ENV_VARS: readonly EnvVarReference[] = [
  {
    name: 'BRIDGE_NAME',
    required: true,
    description: 'Bridge identifier registered with the control plane.',
  },
  {
    name: 'BRIDGE_POLARIS_API_URL',
    required: true,
    description: `Control-plane API URL — \`${API_URL}\` in production.`,
  },
  {
    name: 'BRIDGE_POLARIS_BRIDGE_ID(_FILE)',
    required: true,
    description: 'Bridge ULID minted at registration. `_FILE` form reads from a mounted secret.',
  },
  {
    name: 'BRIDGE_POLARIS_HMAC_KEY(_FILE)',
    required: true,
    description: 'Per-bridge HMAC secret minted at registration.',
  },
  {
    name: 'BRIDGE_TLS_CERT_DIR',
    required: false,
    description:
      'Directory the embedded ACME loop writes `fullchain.pem` + `privkey.pem` into. Default `/var/lib/polaris-bridge/certs`.',
  },
  {
    name: 'BRIDGE_PUBLIC_IP',
    required: false,
    description:
      "Override the IP written to the bridge's own A record. Defaults to first non-loopback IPv4.",
  },
] as const;

export function BridgeConnectionCard({
  bridgeId,
  bridgeName,
  initialHmacKey,
  initialInstallerUrl,
}: BridgeConnectionCardProps) {
  // The HMAC key + install URL flow in via props from the Detail page,
  // which holds the source-of-truth fresh-secrets state and updates
  // them in response to "Roll HMAC Secret". The card is render-only.
  const hmacKey = initialHmacKey ?? HMAC_PLACEHOLDER;
  const installerUrl = initialInstallerUrl ?? null;

  return (
    <section className="space-y-6">
      {installerUrl ? (
        <div className="rounded-md border border-[var(--color-border)] p-4">
          <h2 className="mb-3 text-base font-semibold">One-click install</h2>
          <div className="space-y-1">
            <CodeBlock code={`curl -fsSL ${installerUrl} | sh`} />
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Run on the bridge host. The URL embeds this bridge's current HMAC, so it stays valid
              until the next HMAC roll. The script auto-installs Docker (set{' '}
              <span className="font-mono">POLARIS_AUTO_INSTALL=1</span> for unattended), writes
              compose + secrets, and brings the bridge up.
            </p>
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-[var(--color-border)] p-4">
          <h2 className="mb-3 text-base font-semibold">One-click install</h2>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Click <strong>Roll HMAC Secret</strong> above to mint a fresh{' '}
            <span className="font-mono">dl.mail.plrs.im/bridge/&lt;id&gt;/&lt;hmac&gt;</span>{' '}
            install URL. The URL embeds the HMAC, so it stays valid until the next roll. (Manual
            install instructions are below if you prefer.)
          </p>
        </div>
      )}

      <div className="rounded-md border border-[var(--color-border)] p-4">
        <h2 className="mb-3 text-base font-semibold">Run the bridge</h2>
        <p className="mb-3 text-xs text-[var(--color-muted-foreground)]">
          The bridge fetches its operational secrets from the polaris API at startup over its own
          HMAC channel: the Cloudflare DNS-01 token (used for embedded Let's Encrypt — no Lego
          sidecar), and in Tailscale mode the per-bridge tailnet auth key (a bootstrap init
          container writes it for the TS sidecar). The only on-disk secret you put in place is the
          HMAC key (<span className="font-mono">{HMAC_PLACEHOLDER}</span> below unless you just
          rotated).
        </p>

        <Tabs defaultValue="tailscale">
          <TabsList>
            <TabsTrigger value="tailscale">Tailscale + Docker (default)</TabsTrigger>
            <TabsTrigger value="public">Docker (public host)</TabsTrigger>
            <TabsTrigger value="bare-metal">Bare metal (systemd)</TabsTrigger>
          </TabsList>

          <TabsContent value="tailscale" className="space-y-3">
            <p className="text-xs text-[var(--color-muted-foreground)]">
              A short-lived <span className="font-mono">bootstrap</span> container runs first; it
              HMAC-fetches a fresh tailnet auth key from polaris and writes it to{' '}
              <span className="font-mono">./secrets/ts_authkey</span> before the Tailscale sidecar
              starts — no key handling for you. Other Docker services on the same compose project
              reach the bridge at <span className="font-mono">polaris-mail:465 / 993</span>; tailnet
              members resolve <span className="font-mono">{tailnetHostnameFor(bridgeName)}</span>{' '}
              via MagicDNS. Public DNS (CNAME{' '}
              <span className="font-mono">{fqdnFor(bridgeName)}</span> →{' '}
              <span className="font-mono">
                {tailnetHostnameFor(bridgeName)}.&lt;tailnet&gt;.ts.net
              </span>
              ) optional; the embedded LE cert is valid for both names.
            </p>
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                docker-compose.yml
              </div>
              <CodeBlock code={composeTailscale(bridgeName)} language="yaml" />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                docker-compose.env
              </div>
              <CodeBlock code={envCompanion(bridgeName)} language="bash" />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                Secrets bootstrap
              </div>
              <CodeBlock code={secretsShell(bridgeId, hmacKey, true)} language="bash" />
            </div>
          </TabsContent>

          <TabsContent value="public" className="space-y-3">
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Bridge binds <span className="font-mono">:465 / :993 / :8080</span> on the host
              network. The bridge will write its own CF A record for{' '}
              <span className="font-mono">{fqdnFor(bridgeName)}</span> on startup using the first
              non-loopback IP it can find (override with{' '}
              <span className="font-mono">BRIDGE_PUBLIC_IP</span>).
            </p>
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                docker-compose.yml
              </div>
              <CodeBlock code={composePublic(bridgeName)} language="yaml" />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                docker-compose.env
              </div>
              <CodeBlock code={envCompanion(bridgeName)} language="bash" />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                Secrets bootstrap
              </div>
              <CodeBlock code={secretsShell(bridgeId, hmacKey, false)} language="bash" />
            </div>
          </TabsContent>

          <TabsContent value="bare-metal" className="space-y-3">
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Non-Docker install. The unit file expects{' '}
              <span className="font-mono">/etc/polaris-bridge/bridge.env</span>. ACME state +
              renewed PEMs land under{' '}
              <span className="font-mono">/var/lib/polaris-bridge/certs/</span> automatically.
            </p>
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                /etc/systemd/system/polaris-mail-bridge.service
              </div>
              <CodeBlock code={systemdUnit(bridgeName)} language="ini" />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                /etc/polaris-bridge/bridge.env
              </div>
              <CodeBlock code={bareMetalEnv(bridgeName, hmacKey)} language="bash" />
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <div className="rounded-md border border-[var(--color-border)] p-4">
        <h2 className="mb-3 text-base font-semibold">Environment variable reference</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">
              <th className="pb-2 pr-4 font-medium">Variable</th>
              <th className="pb-2 pr-4 font-medium">Required</th>
              <th className="pb-2 font-medium">Description</th>
            </tr>
          </thead>
          <tbody>
            {ENV_VARS.map((v) => (
              <tr key={v.name} className="border-t border-[var(--color-border)]">
                <td className="py-2 pr-4 align-top font-mono text-xs">{v.name}</td>
                <td className="py-2 pr-4 align-top text-xs">
                  {v.required ? (
                    <span className="text-[var(--color-foreground)]">yes</span>
                  ) : (
                    <span className="text-[var(--color-muted-foreground)]">no</span>
                  )}
                </td>
                <td className="py-2 align-top text-xs text-[var(--color-muted-foreground)]">
                  {v.description}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
