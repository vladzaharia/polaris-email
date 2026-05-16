// 0019 — Policy decisions log. Read-only view of every evaluatePolicy()
// invocation, filterable by verdict / direction / stream / since. Drill
// in via the JSON cell to see the full heuristic reasons vector + LLM
// response details.
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
import { policyKeys } from '../../queryKeys.js';
import { formatRelative } from '../../lib/format.js';
import { ErrorText } from '../../components/ErrorText.js';
import { EmptyState } from '../../components/EmptyState.js';

interface DecisionRow {
  id: string;
  message_id: string | null;
  direction: 'inbound' | 'outbound';
  stream_type: string;
  verdict: 'pass' | 'pass_warn' | 'hold' | 'block';
  total_score: number;
  heuristic_reasons_json: string;
  llm_invoked: number;
  llm_label: string | null;
  llm_confidence: number | null;
  llm_budget_state: string | null;
  decided_at: string;
}

function verdictVariant(v: DecisionRow['verdict']) {
  if (v === 'block') return 'destructive';
  if (v === 'hold') return 'warning';
  if (v === 'pass_warn') return 'secondary';
  return 'success';
}

function topReasons(json: string): string {
  try {
    const arr = JSON.parse(json) as { reason_code: string; score: number }[];
    return arr
      .slice(0, 4)
      .map((r) => `${r.reason_code}(${r.score})`)
      .join(', ');
  } catch {
    return '(unparseable)';
  }
}

const VERDICTS = ['pass', 'pass_warn', 'hold', 'block'] as const;
const STREAMS = ['inbound', 'transactional', 'marketing', 'agent'] as const;

export function PolicyDecisions() {
  const [verdict, setVerdict] = useState('');
  const [direction, setDirection] = useState<'' | 'inbound' | 'outbound'>('');
  const [streamType, setStreamType] = useState('');

  const filters = useMemo(() => {
    const f: Record<string, string> = {};
    if (verdict) f.verdict = verdict;
    if (direction) f.direction = direction;
    if (streamType) f.stream_type = streamType;
    return f;
  }, [verdict, direction, streamType]);

  const path = useMemo(() => {
    const q = new URLSearchParams(filters);
    return q.toString()
      ? `/api/admin/policy/decisions?${q.toString()}`
      : '/api/admin/policy/decisions';
  }, [filters]);

  const q = useAdminQuery<{ data: DecisionRow[] }>(policyKeys.decisions(filters), path);
  const rows = q.data?.data ?? [];

  return (
    <PageCard
      title="Policy decisions"
      description="Every evaluatePolicy() invocation persists here, including the per-heuristic reason vector and (when invoked) the LLM tiebreaker result. Filter to find blocks/holds and triage."
      decorative
    >
      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-4">
        <div>
          <Label>Verdict</Label>
          <Select value={verdict || 'all'} onValueChange={(v) => setVerdict(v === 'all' ? '' : v)}>
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {VERDICTS.map((v) => (
                <SelectItem key={v} value={v}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
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
          <Label>Stream</Label>
          <Select
            value={streamType || 'all'}
            onValueChange={(v) => setStreamType(v === 'all' ? '' : v)}
          >
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {STREAMS.map((s) => (
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
          title="No decisions"
          description="Once the policy engine starts evaluating messages, every decision lands here."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Verdict</TableHead>
              <TableHead>Direction</TableHead>
              <TableHead>Stream</TableHead>
              <TableHead>Score</TableHead>
              <TableHead>LLM</TableHead>
              <TableHead>Top reasons</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell title={r.decided_at}>{formatRelative(r.decided_at)}</TableCell>
                <TableCell>
                  <Badge variant={verdictVariant(r.verdict)}>{r.verdict}</Badge>
                </TableCell>
                <TableCell>{r.direction}</TableCell>
                <TableCell className="font-mono text-xs">{r.stream_type}</TableCell>
                <TableCell className="font-mono">{r.total_score}</TableCell>
                <TableCell className="text-xs">
                  {r.llm_invoked ? (
                    <span>
                      <Badge variant="outline">{r.llm_label ?? '?'}</Badge>{' '}
                      {r.llm_confidence != null ? `(${(r.llm_confidence * 100).toFixed(0)}%)` : ''}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">skipped</span>
                  )}
                </TableCell>
                <TableCell className="max-w-md truncate text-xs" title={r.heuristic_reasons_json}>
                  {topReasons(r.heuristic_reasons_json)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PageCard>
  );
}
