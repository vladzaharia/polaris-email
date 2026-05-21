// Moderation queue. Every held message (inbound or outbound, status='open')
// shows up here with its decision reasons. Per-row release / drop /
// reclassify actions write moderation_feedback rows that feed the inbound
// LLM's few-shot context on the next daily KV refresh.
import { useMemo, useState } from 'react';
import { ArrowLeftRight, CircleDot } from 'lucide-react';
import { PageCard } from '../../layouts/PageCard.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Button } from '../../components/ui/button.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { DestructiveActionDialog } from '../../components/DestructiveActionDialog.js';
import { FilterBar, type FilterSpec } from '../../components/FilterBar.js';
import { FilterEnumPicker } from '../../components/filters/index.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { policyKeys } from '../../queryKeys.js';
import { formatRelative } from '../../lib/format.js';
import { ErrorText } from '../../components/ErrorText.js';
import { EmptyState } from '../../components/EmptyState.js';

interface HeldRow {
  id: string;
  message_id: string | null;
  direction: 'inbound' | 'outbound';
  stream_type: string;
  decision_id: string;
  raw_mime_r2_key: string;
  hold_reason: string;
  hold_until: string;
  released_action: string | null;
  created_at: string;
}

export function PolicyModeration() {
  const [direction, setDirection] = useState<'' | 'inbound' | 'outbound'>('');
  const [status, setStatus] = useState<'open' | 'all' | 'released' | 'dropped'>('open');

  const filters = useMemo(() => {
    const f: Record<string, string> = { status };
    if (direction) f.direction = direction;
    return f;
  }, [direction, status]);

  const path = useMemo(() => {
    const q = new URLSearchParams(filters);
    return q.toString() ? `/api/admin/policy/held?${q.toString()}` : '/api/admin/policy/held';
  }, [filters]);

  const q = useAdminQuery<{ data: HeldRow[] }>(policyKeys.held(filters), path);
  const rows = q.data?.data ?? [];

  const release = useAdminMutation<{ ok: boolean }, { id: string }>(
    (v) => ({
      path: `/api/admin/policy/held/${v.id}/release`,
      method: 'POST',
      body: { action: 'released_as_legit' },
    }),
    { invalidateKeys: [policyKeys.all], successMessage: 'Released' },
  );

  const drop = useAdminMutation<{ ok: boolean }, { id: string; action: string }>(
    (v) => ({
      path: `/api/admin/policy/held/${v.id}/drop`,
      method: 'POST',
      body: { action: v.action },
    }),
    { invalidateKeys: [policyKeys.all], successMessage: 'Dropped' },
  );

  const statusOptions = [
    { value: 'open', label: 'Open' },
    { value: 'released', label: 'Released' },
    { value: 'dropped', label: 'Dropped' },
    { value: 'all', label: 'All' },
  ];

  const filterSpecs: FilterSpec[] = [
    {
      id: 'direction',
      label: 'Direction',
      icon: ArrowLeftRight,
      value: direction || null,
      onChange: (next) =>
        setDirection(typeof next === 'string' && next ? (next as 'inbound' | 'outbound') : ''),
      render: ({ close }) => (
        <FilterEnumPicker
          options={[
            { value: 'inbound', label: 'Inbound' },
            { value: 'outbound', label: 'Outbound' },
          ]}
          value={direction || null}
          onChange={(v) => setDirection(v === null ? '' : (v as 'inbound' | 'outbound'))}
          close={close}
        />
      ),
    },
    {
      id: 'status',
      label: 'Status',
      icon: CircleDot,
      // The status filter is always set (default 'open'); treat the `'all'`
      // value as the "unset" chip state so the picker stays consistent with
      // the rest of the bar. Picking "Any" maps back to `'all'`.
      value: status === 'open' ? 'open' : status === 'all' ? null : status,
      onChange: (next) =>
        setStatus(typeof next === 'string' && next ? (next as typeof status) : 'all'),
      render: ({ close }) => (
        <FilterEnumPicker
          options={statusOptions}
          value={status}
          onChange={(v) => setStatus((v ?? 'all') as typeof status)}
          close={close}
          anyLabel="Any (all)"
        />
      ),
      formatValue: (value) => {
        if (typeof value !== 'string' || !value) return '';
        return statusOptions.find((o) => o.value === value)?.label ?? value;
      },
    },
  ];

  return (
    <PageCard
      title="Moderation queue"
      description="Held messages awaiting review. Release re-injects, drop discards — both feed the LLM."
      decorative
    >
      <FilterBar filters={filterSpecs} />

      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No held messages"
          description="When the policy engine holds a message for moderation it shows up here."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Direction</TableHead>
              <TableHead>Stream</TableHead>
              <TableHead>Reason summary</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-72">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell title={r.created_at}>{formatRelative(r.created_at)}</TableCell>
                <TableCell>
                  <StatusBadge kind="direction" value={r.direction} />
                </TableCell>
                <TableCell className="font-mono text-xs">{r.stream_type}</TableCell>
                <TableCell className="max-w-md truncate" title={r.hold_reason}>
                  {r.hold_reason}
                </TableCell>
                <TableCell>
                  <StatusBadge kind="verdict" value={r.released_action ?? 'open'} />
                </TableCell>
                <TableCell>
                  {r.released_action ? null : (
                    <ModerationRowActions
                      id={r.id}
                      releasePending={release.isPending}
                      dropPending={drop.isPending}
                      onRelease={() => release.mutate({ id: r.id })}
                      onDrop={(action) => drop.mutate({ id: r.id, action })}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PageCard>
  );
}

type DropAction = 'dropped_as_phishing' | 'dropped_as_spam';

function ModerationRowActions(props: {
  id: string;
  releasePending: boolean;
  dropPending: boolean;
  onRelease: () => void;
  onDrop: (action: DropAction) => void;
}) {
  const [confirm, setConfirm] = useState<DropAction | null>(null);
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="default" disabled={props.releasePending} onClick={props.onRelease}>
        Release
      </Button>
      <Button
        size="sm"
        variant="destructive"
        disabled={props.dropPending}
        onClick={() => setConfirm('dropped_as_phishing')}
      >
        Drop (phish)
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={props.dropPending}
        onClick={() => setConfirm('dropped_as_spam')}
      >
        Drop (spam)
      </Button>
      <DestructiveActionDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        action={confirm === 'dropped_as_phishing' ? 'Drop as phishing' : 'Drop as spam'}
        name={props.id}
        blastRadius={[
          'Recipient never receives this message.',
          'Decision is recorded in moderation_feedback and influences future LLM verdicts.',
        ]}
        isPending={props.dropPending}
        onConfirm={() => {
          if (confirm) props.onDrop(confirm);
          setConfirm(null);
        }}
      />
    </div>
  );
}
