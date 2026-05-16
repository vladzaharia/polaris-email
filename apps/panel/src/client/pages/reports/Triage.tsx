// W2b — LLM triage events viewer.
//
// Lists every Workers AI classification with confidence + applied
// suppression. Defaults to "low confidence first" sort so operators
// review the model's least-certain calls first. Each row links to a
// detail view + an "Override" action that records human disagreement
// (and optionally disables the auto-fired suppression).
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
import { Badge } from '../../components/ui/badge.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Label } from '../../components/ui/label.js';
import { useAdminQuery } from '../../hooks/useAdminApi.js';
import { triageKeys } from '../../queryKeys.js';
import { formatRelative } from '../../lib/format.js';
import { ErrorText } from '../../components/ErrorText.js';
import { EmptyState } from '../../components/EmptyState.js';

const CATEGORIES = [
  'spam_complaint',
  'phishing_report',
  'bounce_notification',
  'mailing_list_admin',
  'legal_takedown',
  'inquiry',
  'auto_reply',
  'noise',
] as const;
const SEVERITIES = ['info', 'warn', 'critical'] as const;

interface Row {
  id: string;
  inbound_alias: string | null;
  model: string;
  category: string;
  severity: 'info' | 'warn' | 'critical';
  confidence: number;
  actionable: number;
  target_recipient: string | null;
  target_sender_principal: string | null;
  summary: string | null;
  applied_suppression_id: string | null;
  created_at: string;
}

function severityVariant(s: Row['severity']) {
  return s === 'critical' ? 'destructive' : s === 'warn' ? 'warning' : 'secondary';
}

function categoryVariant(c: string) {
  if (c === 'phishing_report' || c === 'legal_takedown') return 'destructive';
  if (c === 'spam_complaint') return 'warning';
  if (c === 'inquiry' || c === 'mailing_list_admin') return 'secondary';
  return 'outline';
}

function confidenceVariant(c: number) {
  if (c >= 0.85) return 'success';
  if (c >= 0.6) return 'secondary';
  return 'destructive';
}

export function TriageReportsList() {
  const [category, setCategory] = useState('');
  const [severity, setSeverity] = useState('');
  const [sort, setSort] = useState<'created' | 'low_confidence'>('low_confidence');

  const filters = useMemo(() => {
    const f: Record<string, string> = {};
    if (category) f.category = category;
    if (severity) f.severity = severity;
    if (sort === 'low_confidence') f.sort = 'low_confidence';
    return f;
  }, [category, severity, sort]);

  const path = useMemo(() => {
    const q = new URLSearchParams(filters);
    return q.toString() ? `/api/admin/triage-events?${q.toString()}` : '/api/admin/triage-events';
  }, [filters]);

  const q = useAdminQuery<{ data: Row[] }>(triageKeys.list(filters), path);
  const rows = q.data?.data ?? [];

  return (
    <PageCard
      title="LLM triage"
      description="Workers AI classifications of unstructured complaint mail. Low-confidence rows surface first so an operator can review the model's least-certain calls."
      decorative
    >
      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-4">
        <div>
          <Label>Category</Label>
          <Select
            value={category || 'all'}
            onValueChange={(v) => setCategory(v === 'all' ? '' : v)}
          >
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
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
        <div>
          <Label>Sort</Label>
          <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="low_confidence">Low confidence first</SelectItem>
              <SelectItem value="created">Newest first</SelectItem>
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
          title="No triage events"
          description="Events show up here once the Workers AI binding classifies unstructured complaint mail at the platform aliases."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Confidence</TableHead>
              <TableHead>Actionable</TableHead>
              <TableHead>Recipient</TableHead>
              <TableHead>Summary</TableHead>
              <TableHead>Suppression</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell title={r.created_at}>{formatRelative(r.created_at)}</TableCell>
                <TableCell>
                  <Badge variant={categoryVariant(r.category)}>{r.category}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={severityVariant(r.severity)}>{r.severity}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={confidenceVariant(r.confidence)}>
                    {(r.confidence * 100).toFixed(0)}%
                  </Badge>
                </TableCell>
                <TableCell>{r.actionable ? 'yes' : 'no'}</TableCell>
                <TableCell className="font-mono text-xs">{r.target_recipient ?? '—'}</TableCell>
                <TableCell className="max-w-md truncate" title={r.summary ?? ''}>
                  {r.summary ?? '—'}
                </TableCell>
                <TableCell>
                  {r.applied_suppression_id ? (
                    <Badge variant="success">fired</Badge>
                  ) : (
                    <Badge variant="outline">none</Badge>
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
