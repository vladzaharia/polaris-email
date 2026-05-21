// 0019 — Policy decisions log. Read-only view of every evaluatePolicy()
// invocation, filterable by verdict / direction / stream / since. Drill
// in via the JSON cell to see the full heuristic reasons vector + LLM
// response details.
import { useMemo, useState } from 'react';
import { ArrowLeftRight, CalendarRange, CircleDot, Workflow } from 'lucide-react';
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
import { StatusBadge } from '../../components/StatusBadge.js';
import { FilterBar, type FilterSpec } from '../../components/FilterBar.js';
import {
  FilterDateRangePicker,
  FilterEnumPicker,
  type DateRangeValue,
} from '../../components/filters/index.js';
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
  // The API only accepts `since` (lower bound). We use FilterDateRangePicker
  // for UX consistency with /messages but only emit the `since` half.
  const [since, setSince] = useState('');

  const filters = useMemo(() => {
    const f: Record<string, string> = {};
    if (verdict) f.verdict = verdict;
    if (direction) f.direction = direction;
    if (streamType) f.stream_type = streamType;
    if (since) f.since = since;
    return f;
  }, [verdict, direction, streamType, since]);

  const path = useMemo(() => {
    const q = new URLSearchParams(filters);
    return q.toString()
      ? `/api/admin/policy/decisions?${q.toString()}`
      : '/api/admin/policy/decisions';
  }, [filters]);

  const q = useAdminQuery<{ data: DecisionRow[] }>(policyKeys.decisions(filters), path);
  const rows = q.data?.data ?? [];

  const dateRangeValue: DateRangeValue | null = since ? { since } : null;

  const filterSpecs: FilterSpec[] = [
    {
      id: 'verdict',
      label: 'Verdict',
      icon: CircleDot,
      value: verdict || null,
      onChange: (next) => setVerdict(typeof next === 'string' ? next : ''),
      render: ({ close }) => (
        <FilterEnumPicker
          options={VERDICTS.map((v) => ({ value: v }))}
          value={verdict || null}
          onChange={(v) => setVerdict(v ?? '')}
          close={close}
        />
      ),
    },
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
      id: 'stream_type',
      label: 'Stream',
      icon: Workflow,
      value: streamType || null,
      onChange: (next) => setStreamType(typeof next === 'string' ? next : ''),
      render: ({ close }) => (
        <FilterEnumPicker
          options={STREAMS.map((s) => ({ value: s }))}
          value={streamType || null}
          onChange={(v) => setStreamType(v ?? '')}
          close={close}
        />
      ),
    },
    {
      id: 'since',
      label: 'Since',
      icon: CalendarRange,
      value: dateRangeValue,
      onChange: (next) => {
        if (next === null) {
          setSince('');
          return;
        }
        if (typeof next === 'object' && !Array.isArray(next)) {
          setSince(next.since ?? '');
        }
      },
      render: ({ close }) => (
        <FilterDateRangePicker
          value={dateRangeValue}
          onChange={(v) => {
            if (v === null) {
              setSince('');
            } else {
              setSince(v.since ?? '');
            }
          }}
          close={close}
        />
      ),
      formatValue: (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
        return value.since ? `since ${new Date(value.since).toLocaleDateString()}` : '';
      },
    },
  ];

  return (
    <PageCard
      title="Policy decisions"
      description="Per-evaluation policy decisions log."
      decorative
    >
      <FilterBar filters={filterSpecs} />

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
                  <StatusBadge kind="verdict" value={r.verdict} />
                </TableCell>
                <TableCell>
                  <StatusBadge kind="direction" value={r.direction} />
                </TableCell>
                <TableCell className="font-mono text-xs">{r.stream_type}</TableCell>
                <TableCell className="font-mono">{r.total_score}</TableCell>
                <TableCell className="text-xs">
                  {r.llm_invoked ? (
                    <span>
                      <Badge variant="outline">{r.llm_label ?? '?'}</Badge>{' '}
                      {r.llm_confidence != null ? `(${(r.llm_confidence * 100).toFixed(0)}%)` : ''}
                    </span>
                  ) : (
                    <span className="text-[var(--color-muted-foreground)]">skipped</span>
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
