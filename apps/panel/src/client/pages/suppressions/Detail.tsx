// W1 — Suppression detail page.
//
// Shows the complete record (address, reason, scope, severity, source,
// timestamps, notes) plus operator actions. Disabled rows are read-only.
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { PageCard } from '../../layouts/PageCard.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { suppressionKeys } from '../../queryKeys.js';
import { formatRelative } from '../../lib/format.js';
import { ErrorText } from '../../components/ErrorText.js';
import { DestructiveActionDialog } from '../../components/DestructiveActionDialog.js';

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

function severityBadgeVariant(s: SuppressionRow['severity']) {
  return s === 'critical' ? 'destructive' : s === 'warn' ? 'warning' : 'secondary';
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

  if (q.isLoading) {
    return (
      <PageCard title="Suppression" decorative>
        <Skeleton className="h-32 w-full" />
      </PageCard>
    );
  }
  if (q.error || !q.data) {
    return (
      <PageCard title="Suppression" decorative>
        <ErrorText error={q.error ?? 'not found'} />
      </PageCard>
    );
  }
  const r = q.data;

  return (
    <PageCard
      title={`Suppression: ${r.address_normalized}`}
      description={`${r.entity_type === 'recipient' ? 'Recipient' : 'Sender'} — ${r.reason} (${r.source})`}
      decorative
    >
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm md:grid-cols-3">
          <span className="font-medium">Entity</span>
          <span className="md:col-span-2 font-mono">{r.entity_type}</span>
          <span className="font-medium">Address (normalized)</span>
          <span className="md:col-span-2 font-mono">{r.address_normalized}</span>
          <span className="font-medium">Local part / domain</span>
          <span className="md:col-span-2 font-mono">
            {r.address_local ?? '—'} / {r.address_domain ?? '—'}
          </span>
          <span className="font-medium">Scope</span>
          <span className="md:col-span-2 font-mono">
            {r.scope}
            {r.scope_target ? ` (target: ${r.scope_target})` : ''}
          </span>
          <span className="font-medium">Reason</span>
          <span className="md:col-span-2 font-mono">{r.reason}</span>
          <span className="font-medium">Source</span>
          <span className="md:col-span-2 font-mono">
            {r.source}
            {r.source_ref ? ` (ref: ${r.source_ref})` : ''}
          </span>
          <span className="font-medium">Severity</span>
          <span className="md:col-span-2">
            <Badge variant={severityBadgeVariant(r.severity)}>{r.severity}</Badge>
          </span>
          <span className="font-medium">Created</span>
          <span className="md:col-span-2" title={r.created_at}>
            {formatRelative(r.created_at)}
          </span>
          <span className="font-medium">Expires</span>
          <span className="md:col-span-2" title={r.expires_at ?? ''}>
            {r.expires_at ? formatRelative(r.expires_at) : 'never (permanent)'}
          </span>
          <span className="font-medium">State</span>
          <span className="md:col-span-2">
            {r.disabled_at ? (
              <>
                <Badge variant="secondary">disabled</Badge>{' '}
                <span className="text-xs text-muted-foreground">
                  {r.disabled_reason ? `(${r.disabled_reason})` : ''} at{' '}
                  <span title={r.disabled_at}>{formatRelative(r.disabled_at)}</span>
                </span>
              </>
            ) : (
              <Badge variant="success">active</Badge>
            )}
          </span>
          {r.notes && (
            <>
              <span className="font-medium">Notes</span>
              <span className="md:col-span-2 italic">{r.notes}</span>
            </>
          )}
        </div>

        {!r.disabled_at && (
          <>
            <Button variant="outline" onClick={() => setRemoveOpen(true)}>
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
