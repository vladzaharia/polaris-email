// Bridge detail — rotate (one-shot secret reveal) + deregister.
//
// Both actions go through the shared destructive/secret dialogs so the UX
// matches the rest of the panel. The schema stores only the HMAC key hash;
// the rotation response is the single chance to grab the plaintext key.
import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { PageCard } from '../../layouts/PageCard.js';
import { Button } from '../../components/ui/button.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { DestructiveActionDialog } from '../../components/DestructiveActionDialog.js';
import { SecretRevealDialog } from '../../components/SecretRevealDialog.js';
import { ErrorText } from '../../components/ErrorText.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { bridgeKeys } from '../../queryKeys.js';

interface BridgeRow {
  id: string;
  name: string;
  last_seen_at: string | null;
  created_at: string;
  disabled_at: string | null;
}

export function BridgeDetail() {
  const { id } = useParams({ from: '/bridges/$id' });
  const q = useAdminQuery<BridgeRow>(bridgeKeys.detail(id), `/api/admin/bridges/${id}`);
  const [rotated, setRotated] = useState<string | null>(null);
  const [confirmDereg, setConfirmDereg] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  // Rotate is silent — the new HMAC key is surfaced via SecretRevealDialog.
  const rotate = useAdminMutation<{ hmac_key: string }, undefined>(
    () => ({
      path: `/api/admin/bridges/${id}/rotate`,
      method: 'POST',
    }),
    { invalidateKeys: [bridgeKeys.detail(id)], silent: true },
  );
  const dereg = useAdminMutation<unknown, undefined>(
    () => ({
      path: `/api/admin/bridges/${id}`,
      method: 'DELETE',
    }),
    { invalidateKeys: [bridgeKeys.all], successMessage: 'Bridge deregistered.' },
  );

  const breadcrumbs = [{ label: 'Bridges', to: '/bridges' }, { label: q.data?.name ?? id }];
  if (q.isLoading) {
    return (
      <PageCard title="Bridge" breadcrumbs={breadcrumbs} decorative>
        <Skeleton className="h-32 w-full" />
      </PageCard>
    );
  }
  if (q.error || !q.data) {
    return (
      <PageCard title="Bridge" breadcrumbs={breadcrumbs} decorative>
        <ErrorText error={q.error ?? 'Not found.'} />
      </PageCard>
    );
  }
  const d = q.data;

  return (
    <PageCard
      title={d.name}
      breadcrumbs={breadcrumbs}
      description={`Last seen: ${d.last_seen_at ?? 'never'}`}
      decorative
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge kind="bridge" value={d.disabled_at ? 'deregistered' : 'registered'} />
        {d.last_seen_at ? null : <StatusBadge kind="bridge" value="offline" />}
        <Button size="sm" onClick={() => setConfirmRotate(true)} disabled={rotate.isPending}>
          {rotate.isPending ? 'Rotating…' : 'Rotate HMAC key'}
        </Button>
        <Button size="sm" variant="destructive" onClick={() => setConfirmDereg(true)}>
          Deregister
        </Button>
      </div>

      <SecretRevealDialog
        open={rotated != null}
        onOpenChange={(o) => !o && setRotated(null)}
        title="New HMAC key"
        secretLabel="HMAC key"
        secret={rotated}
        note="Configure the bridge with this key. Polaris stores only the hash — there is no way to retrieve this value again."
      />

      <DestructiveActionDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        action="Rotate HMAC key"
        name={d.name}
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

      <DestructiveActionDialog
        open={confirmDereg}
        onOpenChange={setConfirmDereg}
        action="Deregister bridge"
        name={d.name}
        blastRadius={[
          'The bridge is soft-disabled; the HMAC key is rejected on subsequent requests',
          'Active sessions on the bridge will be torn down',
          'Inbound webhooks targeting this bridge will fail',
        ]}
        reversible={false}
        confirmLabel="Deregister"
        onConfirm={async () => {
          await dereg.mutateAsync(undefined);
          setConfirmDereg(false);
        }}
        isPending={dereg.isPending}
      />
    </PageCard>
  );
}
