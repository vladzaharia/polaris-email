// Credential detail — stats + rotate + revoke + code samples.
//
// Rotate returns the new secret via the shared `<SecretRevealDialog>`; the
// panel never stores it (schema is hash-only). Revoke gates behind the
// shared `<DestructiveActionDialog>` with a typed-confirmation of the
// credential id to prevent accidental clicks. Code samples use
// `{{credential_id}}` / `{{sender_address}}` / `{{example_recipient}}`
// placeholders so the operator can copy verbatim.
import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { PageCard } from '../../layouts/PageCard.js';
import { Button } from '../../components/ui/button.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { Badge } from '../../components/ui/badge.js';
import { CodeBlock } from '../../components/CodeBlock.js';
import { DestructiveActionDialog } from '../../components/DestructiveActionDialog.js';
import { SecretRevealDialog } from '../../components/SecretRevealDialog.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { credentialKeys } from '../../queryKeys.js';

interface CredStats {
  credential_id: string;
  window: string;
  counts: { sent: number; delivered: number; failed: number; bounced: number };
}

const curlSample = `curl -X POST https://api.polaris-email.example/v1/messages \\
  -H "X-Polaris-Key-Id: {{credential_id}}" \\
  -H "X-Polaris-Ts: $(date +%s)000" \\
  -H "X-Polaris-Nonce: $(uuidgen)" \\
  -H "X-Polaris-Sig: $SIG" \\
  -H "Content-Type: application/json" \\
  -d '{"from":"{{sender_address}}","to":["{{example_recipient}}"],"subject":"hi","text":"hello"}'`;

const nodeSample = `import { Polaris } from '@polaris/sdk';

const polaris = new Polaris({
  baseUrl: 'https://api.polaris-email.example',
  authBuilder: hmacAuthBuilder({{credential_id}}, process.env.POLARIS_SECRET!),
});
await polaris.sendMessage({
  from: '{{sender_address}}',
  to: ['{{example_recipient}}'],
  subject: 'hi',
  text: 'hello',
});`;

const goSample = `client := polaris.New(polaris.Options{
    BaseURL:   "https://api.polaris-email.example",
    KeyID:     "{{credential_id}}",
    KeySecret: os.Getenv("POLARIS_SECRET"),
})
_, err := client.SendMessage(ctx, &polaris.SendRequest{
    From:    "{{sender_address}}",
    To:      []string{"{{example_recipient}}"},
    Subject: "hi",
    Text:    "hello",
})`;

export function CredentialDetail() {
  const { id } = useParams({ from: '/credentials/$id' });
  const stats = useAdminQuery<CredStats>(
    credentialKeys.stats(id),
    `/api/admin/credentials/${id}/stats?window=24h`,
  );
  // Rotate is silent — the rotated secret is shown via SecretRevealDialog,
  // which is its own UX confirmation. A toast on top would be noisy.
  const rotate = useAdminMutation<{ new_key_secret?: string; secret?: string }, undefined>(
    () => ({
      path: `/api/admin/credentials/${id}/rotate`,
      method: 'POST',
      body: { mode: 'planned' },
    }),
    { silent: true, invalidateKeys: [credentialKeys.all] },
  );
  const revoke = useAdminMutation<unknown, undefined>(
    () => ({
      path: `/api/admin/credentials/${id}/revoke`,
      method: 'POST',
      body: { mode: 'planned' },
    }),
    { invalidateKeys: [credentialKeys.all], successMessage: 'Credential revoked.' },
  );
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  return (
    <PageCard
      title="Credential"
      breadcrumbs={[{ label: 'Credentials', to: '/credentials' }, { label: id }]}
      description={id}
      decorative
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={async () => {
              const r = await rotate.mutateAsync(undefined);
              setRotatedSecret(r.new_key_secret ?? r.secret ?? '(see API response)');
            }}
            disabled={rotate.isPending}
          >
            {rotate.isPending ? 'Rotating…' : 'Rotate'}
          </Button>
          <Button size="sm" variant="destructive" onClick={() => setConfirmRevoke(true)}>
            Revoke
          </Button>
        </div>

        <section>
          <h2 className="mb-2 text-sm font-semibold">Usage (24h)</h2>
          {stats.isLoading ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">Loading…</p>
          ) : stats.error ? (
            <p className="text-sm text-[var(--color-destructive)]">{stats.error.message}</p>
          ) : (
            <div className="flex flex-wrap gap-4 text-sm">
              <span>
                sent <Badge variant="secondary">{stats.data?.counts.sent ?? 0}</Badge>
              </span>
              <span>
                delivered <Badge variant="success">{stats.data?.counts.delivered ?? 0}</Badge>
              </span>
              <span>
                failed <Badge variant="destructive">{stats.data?.counts.failed ?? 0}</Badge>
              </span>
              <span>
                bounced <Badge variant="outline">{stats.data?.counts.bounced ?? 0}</Badge>
              </span>
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold">Code samples</h2>
          <Tabs defaultValue="curl">
            <TabsList>
              <TabsTrigger value="curl">curl</TabsTrigger>
              <TabsTrigger value="node">@polaris/sdk (Node)</TabsTrigger>
              <TabsTrigger value="go">polaris-sdk-go</TabsTrigger>
            </TabsList>
            <TabsContent value="curl" className="mt-3">
              <CodeBlock code={curlSample} language="bash" />
            </TabsContent>
            <TabsContent value="node" className="mt-3">
              <CodeBlock code={nodeSample} language="ts" />
            </TabsContent>
            <TabsContent value="go" className="mt-3">
              <CodeBlock code={goSample} language="go" />
            </TabsContent>
          </Tabs>
        </section>
      </div>

      <SecretRevealDialog
        open={rotatedSecret != null}
        onOpenChange={(o) => !o && setRotatedSecret(null)}
        title="New secret"
        secretLabel="Credential secret"
        secret={rotatedSecret}
        note="Use this secret to sign requests. Polaris stores only the hash — there is no way to retrieve this value again."
      />

      <DestructiveActionDialog
        open={confirmRevoke}
        onOpenChange={setConfirmRevoke}
        action="Revoke credential"
        name={id}
        blastRadius={[
          'In-flight requests authenticating with this credential will fail with 401',
          'New SMTPS/IMAP logins with this credential will fail',
          'Existing message rows remain; only the credential itself is revoked',
        ]}
        reversible={false}
        typedConfirmation={id}
        onConfirm={async () => {
          await revoke.mutateAsync(undefined);
          setConfirmRevoke(false);
        }}
        isPending={revoke.isPending}
      />
    </PageCard>
  );
}
