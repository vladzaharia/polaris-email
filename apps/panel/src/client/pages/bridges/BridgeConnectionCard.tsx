// BridgeConnectionCard — the persistent "how to run this bridge" surface.
//
// Renders five copy-pasteable setup templates with the bridge's name
// pre-filled. The HMAC key is NOT included in any snippet (the schema
// only stores the hash; the plaintext can't be recovered). A
// `<paste-HMAC-key-here>` sentinel + an explicit "Rotate to get a new
// key" affordance is the recovery path.
//
// Variants:
//   * `compose-local`   — docker-compose with `network_mode: host`.
//   * `compose-tailscale` — docker-compose Tailscale sidecar.
//   * `systemd`         — bare-metal unit file referencing /etc/polaris-bridge/bridge.env.
//   * `env`             — full env-file template the systemd unit reads.
//   * `bridge.toml`     — config-file equivalent for bare-metal installs.
//
// The env-var reference table at the bottom is sourced manually from
// `apps/mail-bridge/internal/config/config.go`. Keeping it in sync is on
// the operator-docs cadence; the table is a quick-reference, not a
// generated artifact (the bridge's surface is small enough that drift
// shows up immediately in the wizard QA pass).
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
  // Optional initial key — set by the registration wizard so the freshly-
  // minted plaintext is shown inline once. Detail-page consumers omit it
  // and the snippets display `<paste-HMAC-key-here>` instead.
  initialHmacKey?: string;
  // Whether to expose the "Rotate HMAC key" affordance. False inside the
  // registration wizard (rotation pre-first-deploy is pointless and
  // confusing); true on the persistent Detail-page tab.
  showRotate?: boolean;
}

const HMAC_PLACEHOLDER = '<paste-HMAC-key-here>';

function composeLocal(bridgeName: string, hmacKey: string): string {
  return `# docker-compose.yml
services:
  polaris-mail-bridge:
    image: ghcr.io/vladzaharia/polaris-mail-bridge:latest
    container_name: polaris-mail-bridge
    network_mode: host
    restart: unless-stopped
    environment:
      POLARIS_BRIDGE_NAME: "${bridgeName}"
      POLARIS_API_HOSTNAME: "api.mail.plrs.im"
      POLARIS_BRIDGE_HMAC_KEY: "${hmacKey}"
    volumes:
      - /etc/polaris-bridge/tls:/etc/polaris-bridge/tls:ro
      - polaris-bridge-data:/var/lib/polaris-bridge
volumes:
  polaris-bridge-data:
`;
}

function composeTailscale(bridgeName: string, hmacKey: string): string {
  return `# docker-compose.yml
services:
  polaris-mail-bridge:
    image: ghcr.io/vladzaharia/polaris-mail-bridge:latest
    container_name: polaris-mail-bridge
    restart: unless-stopped
    environment:
      POLARIS_BRIDGE_NAME: "${bridgeName}"
      POLARIS_API_HOSTNAME: "api.mail.plrs.im"
      POLARIS_BRIDGE_HMAC_KEY: "${hmacKey}"
      TS_AUTHKEY: "<tailscale-auth-key>"
      TS_HOSTNAME: "${bridgeName}"
    volumes:
      - polaris-bridge-state:/var/lib/tailscale
      - polaris-bridge-data:/var/lib/polaris-bridge
volumes:
  polaris-bridge-state:
  polaris-bridge-data:
`;
}

function systemdUnit(bridgeName: string): string {
  return `# /etc/systemd/system/polaris-mail-bridge.service
# Bare-metal bridge install. Pair with the env-file below.
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
ReadWritePaths=/var/lib/polaris-bridge

[Install]
WantedBy=multi-user.target
`;
}

function envFile(bridgeName: string, hmacKey: string): string {
  return `# /etc/polaris-bridge/bridge.env
# Loaded by the systemd unit above (or sourced by any wrapper script).
# Mode 0600, owned by polaris-bridge:polaris-bridge — contains the HMAC key.

POLARIS_BRIDGE_NAME=${bridgeName}
POLARIS_API_HOSTNAME=api.mail.plrs.im
POLARIS_BRIDGE_HMAC_KEY=${hmacKey}

# TLS — point at PEM files mounted on the host. Alternative: configure Lego
# env vars for ACME-DNS-01 issuance.
BRIDGE_TLS_MODE=local
BRIDGE_TLS_CERT=/etc/polaris-bridge/tls/fullchain.pem
BRIDGE_TLS_KEY=/etc/polaris-bridge/tls/privkey.pem

# Listener overrides (defaults shown).
BRIDGE_SMTPS_LISTEN_ADDR=:465
BRIDGE_IMAP_LISTEN_ADDR=:993
BRIDGE_WEBHOOK_LISTEN_ADDR=:8080

# Required when the inbound webhook receiver is enabled — must be
# routable from polaris (set to your bridge's externally-resolvable URL).
BRIDGE_PUBLIC_URL=https://${bridgeName}.example.com
`;
}

function bridgeToml(bridgeName: string, hmacKey: string): string {
  return `# /etc/polaris-bridge/bridge.toml
# Alternative to bridge.env for operators who prefer config files.
# Same keys, same semantics; env vars override TOML when both are present.

[bridge]
name = "${bridgeName}"
hmac_key = "${hmacKey}"

[api]
hostname = "api.mail.plrs.im"

[tls]
mode = "local"
cert = "/etc/polaris-bridge/tls/fullchain.pem"
key = "/etc/polaris-bridge/tls/privkey.pem"

[listeners]
smtps_addr = ":465"
imap_addr  = ":993"
webhook_addr = ":8080"

[webhook]
public_url = "https://${bridgeName}.example.com"
`;
}

interface EnvVarReference {
  name: string;
  required: boolean;
  description: string;
}

const ENV_VARS: readonly EnvVarReference[] = [
  {
    name: 'POLARIS_BRIDGE_NAME',
    required: true,
    description: 'Bridge identifier registered with the control plane.',
  },
  {
    name: 'POLARIS_BRIDGE_HMAC_KEY',
    required: true,
    description: 'Per-bridge HMAC secret minted at registration.',
  },
  {
    name: 'POLARIS_API_HOSTNAME',
    required: true,
    description: 'API hostname — typically `api.mail.plrs.im`.',
  },
  {
    name: 'BRIDGE_TLS_MODE',
    required: false,
    description: '`local` (mount PEM) or `lego` (ACME-DNS-01). Defaults to `local`.',
  },
  {
    name: 'BRIDGE_TLS_CERT / BRIDGE_TLS_KEY',
    required: false,
    description: 'PEM paths when `BRIDGE_TLS_MODE=local`.',
  },
  {
    name: 'BRIDGE_PUBLIC_URL',
    required: false,
    description:
      'Externally-routable webhook URL. Required when BRIDGE_WEBHOOK_ENABLED=true (default).',
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
  {
    name: 'BRIDGE_WEBHOOK_LISTEN_ADDR',
    required: false,
    description: 'Inbound webhook listen address. Defaults to `:8080`.',
  },
] as const;

export function BridgeConnectionCard({
  bridgeId,
  bridgeName,
  initialHmacKey,
  showRotate = true,
}: BridgeConnectionCardProps) {
  const [hmacKey] = useState(initialHmacKey ?? HMAC_PLACEHOLDER);
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
          Polaris stores only the hash of the bridge HMAC key. Snippets contain{' '}
          <span className="font-mono">{HMAC_PLACEHOLDER}</span> as a placeholder unless you have
          just rotated. Use the rotate action above to mint a new key when you need one.
        </p>
        <Tabs defaultValue="compose-local">
          <TabsList>
            <TabsTrigger value="compose-local">Docker (local)</TabsTrigger>
            <TabsTrigger value="compose-tailscale">Docker (Tailscale)</TabsTrigger>
            <TabsTrigger value="systemd">systemd unit</TabsTrigger>
            <TabsTrigger value="env">bridge.env</TabsTrigger>
            <TabsTrigger value="toml">bridge.toml</TabsTrigger>
          </TabsList>
          <TabsContent value="compose-local">
            <CodeBlock code={composeLocal(bridgeName, hmacKey)} language="yaml" />
            <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
              Host-network mode. Operator owns firewall + TLS termination at the host (mount PEM at{' '}
              <span className="font-mono">/etc/polaris-bridge/tls/</span>).
            </p>
          </TabsContent>
          <TabsContent value="compose-tailscale">
            <CodeBlock code={composeTailscale(bridgeName, hmacKey)} language="yaml" />
            <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
              Tailnet-fronted. MagicDNS hostname; TLS via tsnet.ListenTLS with Lego ACME-DNS-01
              fallback. Requires a tailnet auth key.
            </p>
          </TabsContent>
          <TabsContent value="systemd">
            <CodeBlock code={systemdUnit(bridgeName)} language="ini" />
            <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
              Drop into <span className="font-mono">/etc/systemd/system/</span>, then
              <span className="font-mono">
                {' '}
                systemctl daemon-reload && systemctl enable --now polaris-mail-bridge
              </span>
              . Pair with the env-file in the next tab.
            </p>
          </TabsContent>
          <TabsContent value="env">
            <CodeBlock code={envFile(bridgeName, hmacKey)} language="bash" />
            <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
              Mode 0600, owned by <span className="font-mono">polaris-bridge:polaris-bridge</span>.
              Contains the HMAC key — treat it like any other secret.
            </p>
          </TabsContent>
          <TabsContent value="toml">
            <CodeBlock code={bridgeToml(bridgeName, hmacKey)} language="toml" />
            <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
              Equivalent to <span className="font-mono">bridge.env</span> above. Either form works;
              env vars take precedence over TOML when both are set.
            </p>
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
        note="Re-configure the bridge with this key. Polaris stores only the hash — there is no way to retrieve this value again."
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
