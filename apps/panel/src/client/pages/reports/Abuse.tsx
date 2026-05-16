// W2 — Abuse events viewer.
//
// Read-only inbox of structured ARF/DSN/LLM-triaged complaints. Filterable
// by sender_address, classification, source, time. Drill-in opens
// `/reports/abuse/$id` with the parsed payload + linked suppression row.
import { Link } from '@tanstack/react-router';
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
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Badge } from '../../components/ui/badge.js';
import { useAdminQuery } from '../../hooks/useAdminApi.js';
import { abuseEventKeys } from '../../queryKeys.js';
import { formatRelative } from '../../lib/format.js';
import { ErrorText } from '../../components/ErrorText.js';
import { EmptyState } from '../../components/EmptyState.js';

const CLASSIFICATIONS = [
  'spam_complaint',
  'phishing_report',
  'virus',
  'auth_failure',
  'opt_out',
  'hard_bounce',
  'legal_takedown',
  'mailing_list_admin',
  'other',
] as const;

const SOURCES = [
  'arf_inbox',
  'llm_triage',
  'cf_bounce_webhook',
  'cf_email_service',
  'panel',
  'cli',
  'import',
] as const;

interface AbuseEventRow {
  id: string;
  sender_address: string | null;
  classification: string;
  source: string;
  weight: number;
  reporter_address: string | null;
  reporter_org: string | null;
  original_message_id: string | null;
  caused_suppression_id: string | null;
  reported_at: string;
}

function classificationBadge(c: string) {
  if (c === 'phishing_report' || c === 'legal_takedown' || c === 'virus') return 'destructive';
  if (c === 'spam_complaint' || c === 'auth_failure') return 'warning';
  if (c === 'hard_bounce') return 'secondary';
  return 'outline';
}

export function AbuseReportsList() {
  const [sender, setSender] = useState('');
  const [classification, setClassification] = useState('');
  const [source, setSource] = useState('');

  const filters = useMemo(() => {
    const f: Record<string, string> = {};
    if (sender) f.sender_address = sender;
    if (classification) f.classification = classification;
    if (source) f.source = source;
    return f;
  }, [sender, classification, source]);

  const path = useMemo(() => {
    const q = new URLSearchParams(filters);
    return q.toString() ? `/api/admin/abuse-events?${q.toString()}` : '/api/admin/abuse-events';
  }, [filters]);

  const q = useAdminQuery<{ data: AbuseEventRow[]; next_cursor: string | null }>(
    abuseEventKeys.list(filters),
    path,
  );

  const rows = q.data?.data ?? [];

  return (
    <PageCard
      title="Abuse reports"
      description="Structured ARF/DSN/LLM-triaged complaints. Read-only ledger; mutations live on the suppressions page."
      decorative
    >
      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-4">
        <div>
          <Label>Sender address</Label>
          <Input
            value={sender}
            onChange={(e) => setSender(e.target.value)}
            placeholder="exact sender address"
          />
        </div>
        <div>
          <Label>Classification</Label>
          <Select
            value={classification || 'all'}
            onValueChange={(v) => setClassification(v === 'all' ? '' : v)}
          >
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {CLASSIFICATIONS.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Source</Label>
          <Select value={source || 'all'} onValueChange={(v) => setSource(v === 'all' ? '' : v)}>
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {SOURCES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
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
          title="No abuse events match"
          description="Reports surface here when ARF/DSN messages arrive at postmaster@/abuse@/webmaster@ or when the CF bounce webhook fires."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reported</TableHead>
              <TableHead>Classification</TableHead>
              <TableHead>Sender</TableHead>
              <TableHead>Reporter</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Weight</TableHead>
              <TableHead>Suppression</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell title={r.reported_at}>{formatRelative(r.reported_at)}</TableCell>
                <TableCell>
                  <Badge variant={classificationBadge(r.classification)}>{r.classification}</Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">{r.sender_address ?? '—'}</TableCell>
                <TableCell className="font-mono text-xs">
                  {r.reporter_address ?? r.reporter_org ?? '—'}
                </TableCell>
                <TableCell className="font-mono text-xs">{r.source}</TableCell>
                <TableCell>{r.weight}</TableCell>
                <TableCell>
                  {r.caused_suppression_id ? (
                    <Link
                      to="/suppressions/$id"
                      params={{ id: r.caused_suppression_id }}
                      className="font-mono text-xs underline"
                    >
                      view
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">none</span>
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
