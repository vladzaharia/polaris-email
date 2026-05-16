// W2c — Sender abuse profile viewer.
//
// One row per sender principal (sender_address | mailbox | domain) with the
// lifetime counters + current_tier surfaced. Filterable by tier (the
// "watchlist" view defaults to tier > 0).
//
// Operator actions live on the suppressions page; this is the read-only
// profile surface.
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
import { senderAbuseKeys } from '../../queryKeys.js';
import { formatRelative } from '../../lib/format.js';
import { ErrorText } from '../../components/ErrorText.js';
import { EmptyState } from '../../components/EmptyState.js';

interface ProfileRow {
  principal_type: 'sender_address' | 'mailbox' | 'domain';
  principal_id: string;
  lifetime_event_count: number;
  lifetime_weighted_score: number;
  suppression_count: number;
  current_tier: number;
  current_tier_started_at: string | null;
  last_suppressed_at: string | null;
  last_event_at: string | null;
}

function tierVariant(t: number) {
  if (t >= 4) return 'destructive';
  if (t >= 2) return 'warning';
  if (t >= 1) return 'secondary';
  return 'outline';
}

export function SenderAbuseList() {
  const [tier, setTier] = useState<string>('');
  const [type, setType] = useState<string>('');

  const filters = useMemo(() => {
    const f: Record<string, string> = {};
    if (tier) f.tier = tier;
    if (type) f.principal_type = type;
    return f;
  }, [tier, type]);

  const path = useMemo(() => {
    const q = new URLSearchParams(filters);
    return q.toString()
      ? `/api/admin/sender-abuse-profiles?${q.toString()}`
      : '/api/admin/sender-abuse-profiles';
  }, [filters]);

  const q = useAdminQuery<{ data: ProfileRow[] }>(senderAbuseKeys.list(filters), path);

  const runNow = useAdminMutation<{ fired: number; candidates: number }, void>(
    () => ({ path: '/api/admin/sender-abuse-threshold/run', method: 'POST' }),
    {
      invalidateKeys: [senderAbuseKeys.all],
      successMessage: 'Threshold cron triggered.',
    },
  );

  const rows = q.data?.data ?? [];

  return (
    <PageCard
      title="Sender abuse profiles"
      description="One row per principal (address / mailbox / domain). Tier advances on each fired suppression and NEVER resets — the platform's permanent memory of sender abuse history."
      decorative
    >
      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-4">
        <div>
          <Label>Tier filter</Label>
          <Select value={tier || 'all'} onValueChange={(v) => setTier(v === 'all' ? '' : v)}>
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="0">Tier 0 (clean)</SelectItem>
              <SelectItem value="1">Tier 1</SelectItem>
              <SelectItem value="2">Tier 2</SelectItem>
              <SelectItem value="3">Tier 3</SelectItem>
              <SelectItem value="4">Tier 4</SelectItem>
              <SelectItem value="5">Tier 5 (permanent)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Principal type</Label>
          <Select value={type || 'all'} onValueChange={(v) => setType(v === 'all' ? '' : v)}>
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="sender_address">Sender address</SelectItem>
              <SelectItem value="mailbox">Mailbox</SelectItem>
              <SelectItem value="domain">Domain</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="md:col-span-2 flex items-end justify-end">
          <Button
            variant="outline"
            onClick={() => runNow.mutate()}
            disabled={runNow.isPending}
            title="Run the W2c threshold cron immediately"
          >
            {runNow.isPending ? 'Running…' : 'Run threshold cron now'}
          </Button>
        </div>
      </div>

      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No sender profiles"
          description="Profiles materialize when abuse_events accumulate against a sender. The threshold cron creates the first row per principal on its first fire."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>Principal</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead>Events (lifetime)</TableHead>
              <TableHead>Weighted score</TableHead>
              <TableHead>Suppressions fired</TableHead>
              <TableHead>Last event</TableHead>
              <TableHead>Last suppressed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={`${r.principal_type}:${r.principal_id}`}>
                <TableCell className="font-mono text-xs">{r.principal_type}</TableCell>
                <TableCell className="font-mono text-xs">{r.principal_id}</TableCell>
                <TableCell>
                  <Badge variant={tierVariant(r.current_tier)}>{r.current_tier}</Badge>
                </TableCell>
                <TableCell>{r.lifetime_event_count}</TableCell>
                <TableCell>{r.lifetime_weighted_score}</TableCell>
                <TableCell>{r.suppression_count}</TableCell>
                <TableCell title={r.last_event_at ?? ''}>
                  {r.last_event_at ? formatRelative(r.last_event_at) : '—'}
                </TableCell>
                <TableCell title={r.last_suppressed_at ?? ''}>
                  {r.last_suppressed_at ? formatRelative(r.last_suppressed_at) : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PageCard>
  );
}
