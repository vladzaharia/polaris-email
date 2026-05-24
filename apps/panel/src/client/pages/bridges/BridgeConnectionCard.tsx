// BridgeConnectionCard — the persistent "how to run this bridge" surface.
//
// Three first-class deployments, each pre-filled with the bridge's name
// (and therefore its `<name>.mail.plrs.im` FQDN — the polaris-mail
// convention is one bridge per host under the mail.plrs.im zone with
// DNS managed in Cloudflare). All three use Lego with Cloudflare
// DNS-01 for TLS; the bridge binary itself only knows
// `BRIDGE_TLS_MODE=local` (mounted PEMs), so Lego writes the cert into
// a shared volume and the bridge loads it from disk.
//
// Each tab renders a docker-compose.yml + companion `.env` so the
// operator can `mkdir polaris-bridge && cd polaris-bridge && curl…
// docker compose --profile lego up -d lego && docker compose up -d`
// without juggling N files. Secrets that vary per bridge (id, HMAC
// key) live as file mounts under `./secrets/` — the snippet text
// notes the shell to create them.
//
// The HMAC key is never embedded in the compose. The fresh
// registration flow shows it once in the Detail-page banner; the
// secret-file shell snippet below is operator-facing and uses a
// `<paste-HMAC-key-here>` placeholder unless a fresh key was passed in.
import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { CodeBlock } from '../../components/CodeBlock.js';
import { Button } from '../../components/ui/button.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { DestructiveActionDialog } from '../../components/DestructiveActionDialog.js';
import { SecretRevealDialog } from '../../components/SecretRevealDialog.js';
import { useAdminMutation } from '../../hooks/useAdminApi.js';
import { bridgeKeys } from '../../queryKeys.js';

interface BridgeConnectionCardProps {
  bridgeId: string;
  bridgeName: string;
  // Optional: the just-minted plaintext HMAC key. Set by the Detail
  // page's fresh-registration banner; omitted afterwards.
  initialHmacKey?: string;
  // Whether to expose the "Rotate HMAC key" affordance. False inside the
  // registration wizard (rotation pre-first-deploy is pointless); true
  // on the persistent Detail-page tab.
  showRotate?: boolean;
}

const HMAC_PLACEHOLDER = '<paste-HMAC-key-here>';
const API_URL = 'https://api.mail.plrs.im';
const IMAGE = 'ghcr.io/vladzaharia/polaris-mail-bridge:latest';

function fqdnFor(bridgeName: string): string {
  return `${bridgeName}.mail.plrs.im`;
}

function tailnetHostnameFor(bridgeName: string): string {
  // Tailscale MagicDNS doesn't allow dots; the convention is
  // `<bridge>-mail`, with `<bridge>.mail.plrs.im` as the public CNAME
  // resolving to the same tailnet node.
  return `${bridgeName}-mail`;
}

// ---------- snippet templates ----------

// Public-host compose: bridge binds 465/993/8080 on the host network;
// Lego mints an LE cert for the public FQDN via CF DNS-01 and writes
// it into a shared volume the bridge mounts read-only.
function composePublicLego(bridgeName: string): string {
  return `# docker-compose.yml — public bridge with Let's Encrypt (CF DNS-01)
#
#   docker compose --profile lego run --rm lego   # first-time + renewals
#   docker compose up -d                          # start the bridge
#
# DNS prerequisite (Cloudflare): an A/AAAA record for
#   ${fqdnFor(bridgeName)}
# pointing at this host's public IP. CF DNS-01 only needs CF API access,
# not the A record — but the A record is what makes the bridge reachable
# at the LE-issued name.
services:
  lego:
    image: goacme/lego:v4.14
    container_name: polaris-mail-lego
    environment:
      CF_DNS_API_TOKEN: \${CF_DNS_API_TOKEN}
    volumes:
      - ./tls:/.lego
    command: >
      run --accept-tos --email \${ACME_EMAIL}
          --domains ${fqdnFor(bridgeName)}
          --dns cloudflare
          --path /.lego
    profiles: [lego]

  bridge:
    image: ${IMAGE}
    container_name: polaris-mail-bridge
    restart: unless-stopped
    ports:
      - '465:465'
      - '993:993'
      - '8080:8080'
    environment:
      BRIDGE_NAME: ${bridgeName}
      BRIDGE_POLARIS_API_URL: ${API_URL}
      BRIDGE_POLARIS_BRIDGE_ID_FILE: /run/secrets/bridge_id
      BRIDGE_POLARIS_HMAC_KEY_FILE: /run/secrets/hmac_key
      BRIDGE_ACCESS_CLIENT_ID: \${ACCESS_CLIENT_ID}
      BRIDGE_ACCESS_CLIENT_SECRET: \${ACCESS_CLIENT_SECRET}
      BRIDGE_PUBLIC_URL: https://${fqdnFor(bridgeName)}:8080
      BRIDGE_TLS_MODE: local
      BRIDGE_TLS_CERT_PATH: /etc/polaris-bridge/tls/certificates/${fqdnFor(bridgeName)}.crt
      BRIDGE_TLS_KEY_PATH: /etc/polaris-bridge/tls/certificates/${fqdnFor(bridgeName)}.key
      BRIDGE_CREDSTORE_PATH: /var/lib/polaris-bridge/credstore.db
      BRIDGE_MIRROR_PATH: /var/lib/polaris-bridge/mirror.db
      BRIDGE_LOGGING_FILE: /var/log/polaris-bridge/audit.jsonl
    volumes:
      - ./tls:/etc/polaris-bridge/tls:ro
      - ./secrets:/run/secrets:ro
      - bridge-data:/var/lib/polaris-bridge
      - bridge-logs:/var/log/polaris-bridge

volumes:
  bridge-data:
  bridge-logs:
`;
}

// Tailnet compose: bridge runs in the tailscale sidecar's network
// namespace. No host ports; access is tailnet-only. Lego still issues
// an LE cert for the public FQDN (via CF DNS-01) so the same cert is
// valid whether the client reaches the bridge via
//   - the tailnet MagicDNS name (<bridge>-mail), or
//   - the public CNAME (<bridge>.mail.plrs.im → tailnet IP)
function composeTailnetLego(bridgeName: string): string {
  const fqdn = fqdnFor(bridgeName);
  const tsHost = tailnetHostnameFor(bridgeName);
  return `# docker-compose.yml — tailnet bridge with Let's Encrypt (CF DNS-01)
#
#   docker compose up -d tailscale               # bring up the tailnet node
#   docker compose --profile lego run --rm lego  # first-time + renewals
#   docker compose up -d                         # start the bridge
#
# DNS prerequisite (Cloudflare): a CNAME record
#   ${fqdn}  →  ${tsHost}.<your-tailnet>.ts.net
# so tailnet members resolve either name to the same node, and the LE
# cert SAN matches both reachability paths.
services:
  tailscale:
    image: tailscale/tailscale:stable
    container_name: polaris-mail-tailscale
    hostname: ${tsHost}
    environment:
      TS_AUTHKEY: \${TS_AUTHKEY}
      TS_STATE_DIR: /var/lib/tailscale
      TS_USERSPACE: 'false'
      TS_EXTRA_ARGS: --advertise-tags=tag:polaris-mail
    volumes:
      - tailscale-state:/var/lib/tailscale
      - /dev/net/tun:/dev/net/tun
    cap_add: [NET_ADMIN, NET_RAW]
    restart: unless-stopped

  lego:
    image: goacme/lego:v4.14
    container_name: polaris-mail-lego
    environment:
      CF_DNS_API_TOKEN: \${CF_DNS_API_TOKEN}
    volumes:
      - lego-certs:/.lego
    command: >
      run --accept-tos --email \${ACME_EMAIL}
          --domains ${fqdn}
          --dns cloudflare
          --path /.lego
    profiles: [lego]

  bridge:
    image: ${IMAGE}
    container_name: polaris-mail-bridge
    restart: unless-stopped
    network_mode: 'service:tailscale'
    depends_on:
      - tailscale
    environment:
      BRIDGE_NAME: ${bridgeName}
      BRIDGE_POLARIS_API_URL: ${API_URL}
      BRIDGE_POLARIS_BRIDGE_ID_FILE: /run/secrets/bridge_id
      BRIDGE_POLARIS_HMAC_KEY_FILE: /run/secrets/hmac_key
      BRIDGE_ACCESS_CLIENT_ID: \${ACCESS_CLIENT_ID}
      BRIDGE_ACCESS_CLIENT_SECRET: \${ACCESS_CLIENT_SECRET}
      BRIDGE_PUBLIC_URL: https://${fqdn}:8080
      BRIDGE_TLS_MODE: local
      BRIDGE_TLS_CERT_PATH: /etc/polaris-bridge/tls/certificates/${fqdn}.crt
      BRIDGE_TLS_KEY_PATH: /etc/polaris-bridge/tls/certificates/${fqdn}.key
      BRIDGE_CREDSTORE_PATH: /var/lib/polaris-bridge/credstore.db
      BRIDGE_MIRROR_PATH: /var/lib/polaris-bridge/mirror.db
      BRIDGE_LOGGING_FILE: /var/log/polaris-bridge/audit.jsonl
    volumes:
      - lego-certs:/etc/polaris-bridge/tls:ro
      - ./secrets:/run/secrets:ro
      - bridge-data:/var/lib/polaris-bridge
      - bridge-logs:/var/log/polaris-bridge

volumes:
  tailscale-state:
  lego-certs:
  bridge-data:
  bridge-logs:
`;
}

function envCompanion(bridgeName: string, withTailscale: boolean): string {
  const tsLine = withTailscale
    ? `TS_AUTHKEY=tskey-auth-...                 # one-shot key minted in the Tailscale admin
`
    : '';
  return `# .env — alongside docker-compose.yml
#
# Don't commit this file. \`chmod 600 .env\` once the values are in.

# Lego DNS-01 (Cloudflare). The token needs Zone:DNS:Edit on mail.plrs.im.
CF_DNS_API_TOKEN=...
ACME_EMAIL=ops@plrs.im

# Cloudflare Access service token fronting the polaris control plane.
# Create one at: https://one.dash.cloudflare.com → Access → Service Auth.
ACCESS_CLIENT_ID=...
ACCESS_CLIENT_SECRET=...

${tsLine}# Bridge identity (pre-filled).
BRIDGE_NAME=${bridgeName}
`;
}

function secretsShell(bridgeId: string, hmacKey: string): string {
  return `# One-time: drop the bridge id + HMAC key into ./secrets as files so the
# compose can mount them at /run/secrets/{bridge_id,hmac_key}. The bridge
# reads them via the *_FILE env vars — the secrets never enter the env
# table.
mkdir -p secrets
echo -n '${bridgeId}' > secrets/bridge_id
echo -n '${hmacKey}' > secrets/hmac_key
chmod 600 secrets/*
`;
}

function systemdUnit(bridgeName: string): string {
  return `# /etc/systemd/system/polaris-mail-bridge.service
# Bare-metal bridge install. Pair with /etc/polaris-bridge/bridge.env.
# TLS is operator-managed PEMs at /etc/polaris-bridge/tls/{fullchain,privkey}.pem.
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
# Loaded by the systemd unit; contains the HMAC key — treat as a secret.

BRIDGE_NAME=${bridgeName}
BRIDGE_POLARIS_API_URL=${API_URL}
BRIDGE_POLARIS_BRIDGE_ID=01H...              # the bridge ULID from registration
BRIDGE_POLARIS_HMAC_KEY=${hmacKey}

# Cloudflare Access service token fronting the polaris API.
BRIDGE_ACCESS_CLIENT_ID=...
BRIDGE_ACCESS_CLIENT_SECRET=...

# Public reachability (used by the inbound webhook bootstrap).
BRIDGE_PUBLIC_URL=https://${fqdnFor(bridgeName)}:8080

# Operator-managed TLS pair (renew however you like; cert paths can be
# repointed at a Lego or Caddy output directory).
BRIDGE_TLS_MODE=local
BRIDGE_TLS_CERT_PATH=/etc/polaris-bridge/tls/fullchain.pem
BRIDGE_TLS_KEY_PATH=/etc/polaris-bridge/tls/privkey.pem

# Local state.
BRIDGE_CREDSTORE_PATH=/var/lib/polaris-bridge/credstore.db
BRIDGE_MIRROR_PATH=/var/lib/polaris-bridge/mirror.db
BRIDGE_LOGGING_FILE=/var/log/polaris-bridge/audit.jsonl
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
    description:
      'Bridge ULID minted at registration. The `_FILE` form reads from a mounted secret.',
  },
  {
    name: 'BRIDGE_POLARIS_HMAC_KEY(_FILE)',
    required: true,
    description: 'Per-bridge HMAC secret minted at registration.',
  },
  {
    name: 'BRIDGE_ACCESS_CLIENT_ID / _SECRET',
    required: true,
    description: 'Cloudflare Access service token fronting the polaris API.',
  },
  {
    name: 'BRIDGE_PUBLIC_URL',
    required: false,
    description:
      'Externally-routable webhook URL. Required when `BRIDGE_WEBHOOK_ENABLED=true` (default).',
  },
  {
    name: 'BRIDGE_TLS_MODE',
    required: true,
    description: 'Always `local` in supported builds. The Lego sidecar handles ACME.',
  },
  {
    name: 'BRIDGE_TLS_CERT_PATH / _KEY_PATH',
    required: true,
    description: 'Paths to the PEM pair. The Lego sidecar writes them under `certificates/`.',
  },
  {
    name: 'BRIDGE_SMTPS_LISTEN_ADDR',
    required: false,
    description: 'SMTPS listen address. Defaults to `:465`.',
  },
  {
    name: 'BRIDGE_IMAP_LISTEN_ADDR',
    required: false,
    description: 'IMAP listen address. Defaults to `:993`.',
  },
] as const;

export function BridgeConnectionCard({
  bridgeId,
  bridgeName,
  initialHmacKey,
  showRotate = true,
}: BridgeConnectionCardProps) {
  const hmacKey = initialHmacKey ?? HMAC_PLACEHOLDER;
  const [rotated, setRotated] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);

  const rotate = useAdminMutation<{ hmac_key: string }, undefined>(
    () => ({ path: `/api/admin/bridges/${bridgeId}/rotate`, method: 'POST' }),
    { invalidateKeys: [bridgeKeys.detail(bridgeId)], silent: true },
  );

  return (
    <section className="space-y-6">
      <div className="rounded-md border border-[var(--color-border)] p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Run the bridge</h2>
          {showRotate ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirmRotate(true)}
              disabled={rotate.isPending}
            >
              <KeyRound className="h-3.5 w-3.5" aria-hidden />
              {rotate.isPending ? 'Rotating…' : 'Rotate HMAC key'}
            </Button>
          ) : null}
        </div>
        <p className="mb-3 text-xs text-[var(--color-muted-foreground)]">
          All three deployments expect the bridge to live at{' '}
          <span className="font-mono">{fqdnFor(bridgeName)}</span>. The HMAC key (
          <span className="font-mono">{HMAC_PLACEHOLDER}</span> below unless you just rotated) goes
          in <span className="font-mono">./secrets/hmac_key</span> — never the compose or env file.
        </p>

        <Tabs defaultValue="public-lego">
          <TabsList>
            <TabsTrigger value="public-lego">Docker + Let's Encrypt</TabsTrigger>
            <TabsTrigger value="tailnet-lego">Tailscale + Let's Encrypt</TabsTrigger>
            <TabsTrigger value="bare-metal">Bare metal (systemd)</TabsTrigger>
          </TabsList>

          <TabsContent value="public-lego" className="space-y-3">
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Bridge binds <span className="font-mono">:465 / :993 / :8080</span> on the host
              network. Lego mints an LE cert for{' '}
              <span className="font-mono">{fqdnFor(bridgeName)}</span> via Cloudflare DNS-01 and
              writes it into a shared volume. Operator owns the firewall.
            </p>
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                docker-compose.yml
              </div>
              <CodeBlock code={composePublicLego(bridgeName)} language="yaml" />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                .env
              </div>
              <CodeBlock code={envCompanion(bridgeName, false)} language="bash" />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                Secrets bootstrap
              </div>
              <CodeBlock code={secretsShell(bridgeId, hmacKey)} language="bash" />
            </div>
          </TabsContent>

          <TabsContent value="tailnet-lego" className="space-y-3">
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Bridge runs inside the Tailscale sidecar's network namespace — no public ports.
              Tailnet members reach it at{' '}
              <span className="font-mono">{tailnetHostnameFor(bridgeName)}</span> (MagicDNS) or
              <span className="font-mono"> {fqdnFor(bridgeName)}</span> (CNAME to the same node).
              Lego still issues the cert against the public FQDN via CF DNS-01 so both names
              validate with one certificate.
            </p>
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                docker-compose.yml
              </div>
              <CodeBlock code={composeTailnetLego(bridgeName)} language="yaml" />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                .env
              </div>
              <CodeBlock code={envCompanion(bridgeName, true)} language="bash" />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                Secrets bootstrap
              </div>
              <CodeBlock code={secretsShell(bridgeId, hmacKey)} language="bash" />
            </div>
          </TabsContent>

          <TabsContent value="bare-metal" className="space-y-3">
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Non-Docker install. The unit file expects{' '}
              <span className="font-mono">/etc/polaris-bridge/bridge.env</span> and a PEM pair at{' '}
              <span className="font-mono">/etc/polaris-bridge/tls/</span> — renew with whatever you
              already use (certbot, lego, caddy).
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

      <SecretRevealDialog
        open={rotated != null}
        onOpenChange={(o) => !o && setRotated(null)}
        title="New HMAC key"
        secretLabel="HMAC key"
        secret={rotated}
        note="Re-write ./secrets/hmac_key on the bridge host with this value, then restart the bridge. Polaris stores only the hash — there is no way to retrieve this value again."
      />

      <DestructiveActionDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        action="Rotate HMAC key"
        name={bridgeName}
        blastRadius={[
          'The previous HMAC key is invalidated immediately',
          'The bridge must be reconfigured with the new key before it can reconnect',
          'Webhook deliveries signed with the old key are rejected',
        ]}
        reversible={false}
        confirmLabel="Rotate HMAC key"
        onConfirm={async () => {
          const r = await rotate.mutateAsync(undefined);
          setConfirmRotate(false);
          setRotated(r.hmac_key);
        }}
        isPending={rotate.isPending}
      />
    </section>
  );
}
