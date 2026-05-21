// Bridges list + register modal.
//
// Registration mints a fresh HMAC key — the schema stores only the hash, so
// the response is the single chance to capture the plaintext key. The modal
// shows it alongside copy-pasteable run instructions for both supported
// deployment modes (Tailscale sidecar + local host-network).
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { PageCard } from '../../layouts/PageCard.js';
import { PaginatedTable } from '../../components/PaginatedTable.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../components/ui/dialog.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { SecretRevealDialog } from '../../components/SecretRevealDialog.js';
import { ErrorText } from '../../components/ErrorText.js';
import { CodeBlock } from '../../components/CodeBlock.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { bridgeKeys } from '../../queryKeys.js';
import { formatDate, formatRelative } from '../../lib/format.js';

interface BridgeRow {
  id: string;
  name: string;
  last_seen_at: string | null;
  created_at: string;
  disabled_at: string | null;
}

interface RegisteredBridge {
  id: string;
  name: string;
  hmacKey: string;
}

function localComposeSnippet(bridgeName: string): string {
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
      POLARIS_BRIDGE_HMAC_KEY: "<paste-HMAC-key-here>"
    volumes:
      - /etc/polaris-bridge/tls:/etc/polaris-bridge/tls:ro
      - polaris-bridge-data:/var/lib/polaris-bridge
volumes:
  polaris-bridge-data:
`;
}

function tailscaleComposeSnippet(bridgeName: string): string {
  return `# docker-compose.yml
services:
  polaris-mail-bridge:
    image: ghcr.io/vladzaharia/polaris-mail-bridge:latest
    container_name: polaris-mail-bridge
    restart: unless-stopped
    environment:
      POLARIS_BRIDGE_NAME: "${bridgeName}"
      POLARIS_API_HOSTNAME: "api.mail.plrs.im"
      POLARIS_BRIDGE_HMAC_KEY: "<paste-HMAC-key-here>"
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

function quickStartSnippet(bridgeName: string, hmacKey: string): string {
  return `# Quick start
docker run -d --name polaris-mail-bridge \\
  --network host --restart unless-stopped \\
  -e POLARIS_BRIDGE_NAME="${bridgeName}" \\
  -e POLARIS_API_HOSTNAME="api.mail.plrs.im" \\
  -e POLARIS_BRIDGE_HMAC_KEY="${hmacKey}" \\
  ghcr.io/vladzaharia/polaris-mail-bridge:latest
`;
}

function AddBridgeDialog({ onRegistered }: { onRegistered: (b: RegisteredBridge) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const register = useAdminMutation<{ id: string; hmac_key: string }, { name: string }>(
    (vars) => ({ path: '/api/admin/bridges', method: 'POST', body: vars }),
    { invalidateKeys: [bridgeKeys.all], silent: true },
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setName('');
          register.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="icon" title="Add bridge" aria-label="Add bridge">
          <Plus className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register on-prem bridge</DialogTitle>
          <DialogDescription>
            Mints a fresh HMAC key for this bridge. Polaris stores only the hash — the next dialog
            is the only chance to copy the key.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="bn">Bridge name</Label>
            <Input
              id="bn"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="acme-mx-1"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
              Lowercase, hyphenated. The operator chooses where this bridge runs.
            </p>
            {name.trim() ? (
              <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                Will mint a fresh HMAC key for bridge{' '}
                <span className="font-mono">{name.trim()}</span>.
              </p>
            ) : null}
          </div>
          <ErrorText error={register.error} />
        </div>
        <DialogFooter>
          <Button
            disabled={!name.trim() || register.isPending}
            onClick={async () => {
              const r = await register.mutateAsync({ name: name.trim() });
              onRegistered({ id: r.id, name: name.trim(), hmacKey: r.hmac_key });
              setName('');
              setOpen(false);
            }}
          >
            {register.isPending ? 'Registering…' : 'Register bridge'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BridgeInstructionsDialog({
  bridge,
  onOpenChange,
}: {
  bridge: RegisteredBridge | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={bridge != null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Bridge {bridge?.name} registered</DialogTitle>
          <DialogDescription>
            Copy the HMAC key now — Polaris stores only the hash, there is no way to retrieve this
            value again. Then run the bridge using one of the deployment modes below.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>HMAC key</Label>
            <CodeBlock code={bridge?.hmacKey ?? ''} />
          </div>
          <div>
            <Label>Run the bridge</Label>
            <Tabs defaultValue="quick" className="mt-2">
              <TabsList>
                <TabsTrigger value="quick">Quick start</TabsTrigger>
                <TabsTrigger value="local">Local (host-network)</TabsTrigger>
                <TabsTrigger value="tailscale">Tailscale sidecar</TabsTrigger>
              </TabsList>
              <TabsContent value="quick">
                <CodeBlock
                  code={bridge ? quickStartSnippet(bridge.name, bridge.hmacKey) : ''}
                  language="bash"
                />
                <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
                  Smallest-possible invocation. Listens on the host's :465 (SMTPS) and :993 (IMAP).
                </p>
              </TabsContent>
              <TabsContent value="local">
                <CodeBlock code={bridge ? localComposeSnippet(bridge.name) : ''} language="yaml" />
                <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
                  Operator owns the firewall + TLS termination. Mount PEM material at
                  <span className="font-mono"> /etc/polaris-bridge/tls/</span> or set Lego env vars
                  for ACME-DNS-01.
                </p>
              </TabsContent>
              <TabsContent value="tailscale">
                <CodeBlock
                  code={bridge ? tailscaleComposeSnippet(bridge.name) : ''}
                  language="yaml"
                />
                <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
                  Tailnet-fronted. MagicDNS hostname; TLS via tsnet.ListenTLS with Lego ACME-DNS-01
                  fallback. Requires a tailnet auth key.
                </p>
              </TabsContent>
            </Tabs>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BridgesList() {
  const q = useAdminQuery<{ data: BridgeRow[] }>(bridgeKeys.list(), '/api/admin/bridges');
  const [registered, setRegistered] = useState<RegisteredBridge | null>(null);
  const [legacyReveal, setLegacyReveal] = useState<string | null>(null);
  // The instructions dialog owns the HMAC reveal too. SecretRevealDialog
  // stays as a fallback for any caller that prefers the plain reveal UX
  // (kept for back-compat if other code paths set it).
  void legacyReveal;
  void setLegacyReveal;
  return (
    <PageCard
      title="Bridges"
      description="On-prem submission/IMAP bridges."
      decorative
      actions={<AddBridgeDialog onRegistered={setRegistered} />}
    >
      {q.error ? (
        <ErrorText error={q.error} />
      ) : (
        <PaginatedTable<BridgeRow>
          caption="Registered on-prem bridges and their last heartbeat."
          loading={q.isLoading}
          rows={q.data?.data ?? []}
          empty="No bridges registered."
          rowKey={(d) => d.id}
          columns={[
            {
              key: 'name',
              header: 'Name',
              cell: (d) => (
                <Link to="/bridges/$id" params={{ id: d.id }} className="underline">
                  {d.name}
                </Link>
              ),
            },
            {
              key: 'last_seen_at',
              header: 'Last seen',
              className: 'text-xs',
              cell: (d) => (
                <span title={d.last_seen_at ? formatDate(d.last_seen_at) : undefined}>
                  {formatRelative(d.last_seen_at)}
                </span>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (d) => (
                <StatusBadge kind="bridge" value={d.disabled_at ? 'deregistered' : 'registered'} />
              ),
            },
          ]}
        />
      )}

      <BridgeInstructionsDialog
        bridge={registered}
        onOpenChange={(o) => !o && setRegistered(null)}
      />

      <SecretRevealDialog
        open={false}
        onOpenChange={() => {}}
        title=""
        secretLabel="HMAC key"
        secret={null}
        note=""
      />
    </PageCard>
  );
}
