// W1 — Suppression detail page.
//
// Shows the complete record (address, reason, scope, severity, source,
// timestamps, notes) plus operator actions. Disabled rows are read-only.
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { PageCard } from '../../layouts/PageCard.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Button } from '../../components/ui/button.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { suppressionKeys } from '../../queryKeys.js';
import { formatRelative } from '../../lib/format.js';
import { ErrorText } from '../../components/ErrorText.js';
import { DestructiveActionDialog } from '../../components/DestructiveActionDialog.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { MetaList, MetaRow } from '../../components/MetaList.js';

interface SuppressionRow {
  id: string;
  entity_type: 'recipient' | 'sender';
  address_normalized: string;
  address_local: string | null;
  address_domain: string | null;
  scope: string;
  scope_target: string | null;
  reason: string;
  source: string;
  source_ref: string | null;
  severity: 'info' | 'warn' | 'critical';
  created_at: string;
  expires_at: string | null;
  disabled_at: string | null;
  disabled_reason: string | null;
  notes: string | null;
}

export function SuppressionDetail() {
  const { id } = useParams({ from: '/suppressions/$id' });
  const [removeOpen, setRemoveOpen] = useState(false);
  const q = useAdminQuery<SuppressionRow>(
    suppressionKeys.detail(id),
    `/api/admin/suppressions/${id}`,
  );

  const remove = useAdminMutation<{ id: string; disabled_at: string }, { reason: string }>(
    (vars) => ({
      path: `/api/admin/suppressions/${id}?reason=${encodeURIComponent(vars.reason)}`,
      method: 'DELETE',
    }),
    { invalidateKeys: [suppressionKeys.all], silent: true },
  );

  // Suppressions list folded into the AbuseHub as the `suppressions` tab,
  // so the breadcrumb up-link points back there instead of the retired
  // standalone /suppressions list route.
  const breadcrumbs = [
    { label: 'Abuse & alerts', to: '/abuse', search: { tab: 'suppressions' } },
    { label: q.data?.address_normalized ?? id },
  ];

  if (q.isLoading) {
    return (
      <PageCard title="Suppression" breadcrumbs={breadcrumbs} decorative>
        <Skeleton className="h-32 w-full" />
      </PageCard>
    );
  }
  if (q.error || !q.data) {
    return (
      <PageCard title="Suppression" breadcrumbs={breadcrumbs} decorative>
        <ErrorText error={q.error ?? 'not found'} />
      </PageCard>
    );
  }
  const r = q.data;

  return (
    <PageCard
      title={`Suppression: ${r.address_normalized}`}
      breadcrumbs={breadcrumbs}
      description={`${r.entity_type === 'recipient' ? 'Recipient' : 'Sender'} — ${r.reason} (${r.source})`}
      decorative
    >
      <div className="space-y-6">
        <MetaList>
          <MetaRow label="Entity">
            <span className="font-mono">{r.entity_type}</span>
          </MetaRow>
          <MetaRow label="Address (normalized)">
            <span className="font-mono">{r.address_normalized}</span>
          </MetaRow>
          <MetaRow label="Local part / domain">
            <span className="font-mono">
              {r.address_local ?? '—'} / {r.address_domain ?? '—'}
            </span>
          </MetaRow>
          <MetaRow label="Scope">
            <span className="font-mono">
              {r.scope}
              {r.scope_target ? ` (target: ${r.scope_target})` : ''}
            </span>
          </MetaRow>
          <MetaRow label="Reason">
            <span className="font-mono">{r.reason}</span>
          </MetaRow>
          <MetaRow label="Source">
            <span className="font-mono">
              {r.source}
              {r.source_ref ? ` (ref: ${r.source_ref})` : ''}
            </span>
          </MetaRow>
          <MetaRow label="Severity">
            <StatusBadge kind="severity" value={r.severity} />
          </MetaRow>
          <MetaRow label="Created">
            <span title={r.created_at}>{formatRelative(r.created_at)}</span>
          </MetaRow>
          <MetaRow label="Expires">
            <span title={r.expires_at ?? ''}>
              {r.expires_at ? formatRelative(r.expires_at) : 'never (permanent)'}
            </span>
          </MetaRow>
          <MetaRow label="State">
            {r.disabled_at ? (
              <>
                <StatusBadge kind="enabled" value="disabled" />{' '}
                <span className="text-xs text-[var(--color-muted-foreground)]">
                  {r.disabled_reason ? `(${r.disabled_reason})` : ''} at{' '}
                  <span title={r.disabled_at}>{formatRelative(r.disabled_at)}</span>
                </span>
              </>
            ) : (
              <StatusBadge kind="enabled" value="active" />
            )}
          </MetaRow>
          {r.notes ? (
            <MetaRow label="Notes">
              <span className="italic">{r.notes}</span>
            </MetaRow>
          ) : null}
        </MetaList>

        {!r.disabled_at && (
          <>
            <Button size="sm" variant="outline" onClick={() => setRemoveOpen(true)}>
              Remove suppression
            </Button>
            <DestructiveActionDialog
              open={removeOpen}
              onOpenChange={setRemoveOpen}
              action={`Remove suppression for ${r.address_normalized}`}
              reversible={true}
              blastRadius={[
                r.entity_type === 'sender'
                  ? 'This sender will be able to send mail again immediately.'
                  : 'Mail to this recipient will resume on the next send.',
                'The suppression row stays in the audit log; you can re-add it later.',
              ]}
              onConfirm={async () => {
                await remove.mutateAsync({ reason: 'operator_override_from_detail' });
              }}
              isPending={remove.isPending}
            />
          </>
        )}
      </div>
    </PageCard>
  );
}
