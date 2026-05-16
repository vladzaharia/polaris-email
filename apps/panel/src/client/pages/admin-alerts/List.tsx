// W2d — Admin alerts viewer.
//
// Chronological list of every alert the platform emitted. Filterable by
// type/severity/target/since. "Test alert" button at the top fires a
// synthetic alert end-to-end so the operator can verify ALERT_WEBHOOK is
// reachable and dedupe is sane.
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
import { adminAlertKeys } from '../../queryKeys.js';
import { formatRelative } from '../../lib/format.js';
import { ErrorText } from '../../components/ErrorText.js';
import { EmptyState } from '../../components/EmptyState.js';

const TYPES = [
  'sender_suppressed',
  'phishing_report_received',
  'legal_takedown_received',
  'sender_threshold_breached',
  'tls_rpt_failure_burst',
  'dmarc_alignment_drop',
  'synthetic_check_failed',
  'manual',
] as const;

const SEVERITIES = ['info', 'warn', 'critical'] as const;

interface AdminAlertRow {
  id: string;
  alert_type: string;
  severity: 'info' | 'warn' | 'critical';
  target: string;
  subject: string;
  body: string;
  delivery: string;
  payload: string;
  created_at: string;
}

function severityVariant(s: AdminAlertRow['severity']) {
  return s === 'critical' ? 'destructive' : s === 'warn' ? 'warning' : 'secondary';
}

export function AdminAlertsList() {
  const [type, setType] = useState('');
  const [severity, setSeverity] = useState('');

  const filters = useMemo(() => {
    const f: Record<string, string> = {};
    if (type) f.alert_type = type;
    if (severity) f.severity = severity;
    return f;
  }, [type, severity]);

  const path = useMemo(() => {
    const q = new URLSearchParams(filters);
    return q.toString() ? `/api/admin/alerts?${q.toString()}` : '/api/admin/alerts';
  }, [filters]);

  const q = useAdminQuery<{ data: AdminAlertRow[] }>(adminAlertKeys.list(filters), path);

  const test = useAdminMutation<{ id: string; deduped: boolean }, void>(
    () => ({ path: '/api/admin/alerts/test', method: 'POST' }),
    { invalidateKeys: [adminAlertKeys.all], successMessage: 'Test alert fired.' },
  );

  const rows = q.data?.data ?? [];

  return (
    <PageCard
      title="Admin alerts"
      description="Operator-facing alert history. Auto-fired by sender suppressions, phishing/legal classifications, threshold breaches, and synthetic check failures."
      decorative
    >
      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-4">
        <div>
          <Label>Type</Label>
          <Select value={type || 'all'} onValueChange={(v) => setType(v === 'all' ? '' : v)}>
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Severity</Label>
          <Select
            value={severity || 'all'}
            onValueChange={(v) => setSeverity(v === 'all' ? '' : v)}
          >
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {SEVERITIES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="md:col-span-2 flex items-end justify-end">
          <Button
            variant="outline"
            onClick={() => test.mutate()}
            disabled={test.isPending}
            title="Fires a synthetic alert end-to-end so you can confirm ALERT_WEBHOOK is reachable + dedupe works"
          >
            {test.isPending ? 'Firing…' : 'Send test alert'}
          </Button>
        </div>
      </div>

      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No alerts yet"
          description="Alerts surface here when sender suppressions fire, phishing/legal reports come in, or synthetic checks fail. Press 'Send test alert' to verify the pipeline."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Delivery</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const delivery = (() => {
                try {
                  return JSON.parse(r.delivery) as Array<{ channel: string; ok: boolean }>;
                } catch {
                  return [];
                }
              })();
              return (
                <TableRow key={r.id}>
                  <TableCell title={r.created_at}>{formatRelative(r.created_at)}</TableCell>
                  <TableCell>
                    <Badge variant={severityVariant(r.severity)}>{r.severity}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.alert_type}</TableCell>
                  <TableCell className="font-mono text-xs">{r.target}</TableCell>
                  <TableCell className="max-w-md truncate" title={r.subject}>
                    {r.subject}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {delivery.map((d) => `${d.channel}:${d.ok ? '✓' : '✗'}`).join(' ')}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </PageCard>
  );
}
