// 0019 — Moderation queue. The centrepiece of the policy-engine panel
// surface: every held message (inbound or outbound, status='open') shows
// up here with its decision reasons. Per-row release / drop / reclassify
// actions write moderation_feedback rows that feed the inbound LLM's
// few-shot context on the next daily KV refresh.
import { useMemo, useState } from 'react';
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
import { Badge } from '../../components/ui/badge.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Label } from '../../components/ui/label.js';
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

  return (
    <PageCard
      title="Moderation queue"
      description="Held messages await admin review. Release re-sends (outbound) or re-injects (inbound); drop discards the message. Both actions feed the LLM few-shot window via moderation_feedback."
      decorative
    >
      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-3">
        <div>
          <Label>Direction</Label>
          <Select
            value={direction || 'all'}
            onValueChange={(v) => setDirection(v === 'all' ? '' : (v as 'inbound' | 'outbound'))}
          >
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="inbound">Inbound</SelectItem>
              <SelectItem value="outbound">Outbound</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Status</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="released">Released</SelectItem>
              <SelectItem value="dropped">Dropped</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

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
                  <Badge variant={r.direction === 'inbound' ? 'secondary' : 'outline'}>
                    {r.direction}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">{r.stream_type}</TableCell>
                <TableCell className="max-w-md truncate" title={r.hold_reason}>
                  {r.hold_reason}
                </TableCell>
                <TableCell>
                  {r.released_action ? (
                    <Badge variant={r.released_action === 'released' ? 'success' : 'destructive'}>
                      {r.released_action}
                    </Badge>
                  ) : (
                    <Badge variant="warning">open</Badge>
                  )}
                </TableCell>
                <TableCell>
                  {r.released_action ? null : (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="default"
                        disabled={release.isPending}
                        onClick={() => release.mutate({ id: r.id })}
                      >
                        Release
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={drop.isPending}
                        onClick={() => drop.mutate({ id: r.id, action: 'dropped_as_phishing' })}
                      >
                        Drop (phish)
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={drop.isPending}
                        onClick={() => drop.mutate({ id: r.id, action: 'dropped_as_spam' })}
                      >
                        Drop (spam)
                      </Button>
                    </div>
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
