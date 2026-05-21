// Messages list — filters → GET /v1/messages.
//
// Dense, status-coloured rows. Each row is clickable (programmatic navigate
// from anywhere on the row, plus an explicit `<Link>` wrapping the subject
// so middle-click and Cmd-click open in a new tab). When the message is in
// a terminal-error state (`failed` or `bounced`), the row picks up a 2px
// destructive left-edge accent so failures jump out of the table.
import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeftRight, AtSign, CalendarRange, CircleDot } from 'lucide-react';
import { PageCard } from '../../layouts/PageCard.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { Button } from '../../components/ui/button.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorText } from '../../components/ErrorText.js';
import { FilterBar, type FilterSpec } from '../../components/FilterBar.js';
import {
  FilterAddressPicker,
  FilterDateRangePicker,
  FilterEnumPicker,
  type DateRangeValue,
} from '../../components/filters/index.js';
import { useAdminQuery } from '../../hooks/useAdminApi.js';
import { messageKeys } from '../../queryKeys.js';
import { formatRelative } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';

interface MessageRow {
  id: string;
  direction: 'in' | 'out';
  status: string;
  from: string;
  to: string[];
  subject?: string;
  created_at?: string;
}

const STATUS_VALUES = [
  'queued',
  'sending',
  'sent',
  'delivered',
  'failed',
  'bounced',
  'received',
] as const;

export function MessagesList() {
  const navigate = useNavigate();
  const [direction, setDirection] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);

  const params = new URLSearchParams();
  if (direction) params.set('direction', direction);
  if (status) params.set('status', status);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (since) params.set('since', since);
  if (until) params.set('until', until);
  if (q) params.set('q', q);
  params.set('limit', '50');
  params.set('offset', String(offset));

  const query = useAdminQuery<{ data: MessageRow[]; next_offset: number | null }>(
    [...messageKeys.list(), params.toString()] as const,
    `/api/messages?${params.toString()}`,
  );

  const dateRangeValue: DateRangeValue | null =
    since || until ? { ...(since ? { since } : {}), ...(until ? { until } : {}) } : null;

  const filterSpecs: FilterSpec[] = [
    {
      id: 'direction',
      label: 'Direction',
      icon: ArrowLeftRight,
      value: direction || null,
      onChange: (next) => setDirection(typeof next === 'string' ? next : ''),
      render: ({ close }) => (
        <FilterEnumPicker
          options={[
            { value: 'in', label: 'in' },
            { value: 'out', label: 'out' },
          ]}
          value={direction || null}
          onChange={(v) => setDirection(v ?? '')}
          close={close}
        />
      ),
    },
    {
      id: 'status',
      label: 'Status',
      icon: CircleDot,
      value: status || null,
      onChange: (next) => setStatus(typeof next === 'string' ? next : ''),
      render: ({ close }) => (
        <FilterEnumPicker
          options={STATUS_VALUES.map((s) => ({ value: s }))}
          value={status || null}
          onChange={(v) => setStatus(v ?? '')}
          close={close}
        />
      ),
    },
    {
      id: 'date',
      label: 'Date',
      icon: CalendarRange,
      value: dateRangeValue,
      onChange: (next) => {
        if (next === null) {
          setSince('');
          setUntil('');
          return;
        }
        if (typeof next === 'object' && !Array.isArray(next)) {
          setSince(next.since ?? '');
          setUntil(next.until ?? '');
        }
      },
      render: ({ close }) => (
        <FilterDateRangePicker
          value={dateRangeValue}
          onChange={(v) => {
            if (v === null) {
              setSince('');
              setUntil('');
            } else {
              setSince(v.since ?? '');
              setUntil(v.until ?? '');
            }
          }}
          close={close}
        />
      ),
      formatValue: (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
        const fmt = (s?: string) => (s ? new Date(s).toLocaleDateString() : '');
        const a = fmt(value.since);
        const b = fmt(value.until);
        if (a && b) return `${a} → ${b}`;
        if (a) return `since ${a}`;
        if (b) return `until ${b}`;
        return '';
      },
    },
    {
      id: 'from',
      label: 'From',
      icon: AtSign,
      value: from || null,
      onChange: (next) => setFrom(typeof next === 'string' ? next : ''),
      render: ({ close }) => (
        <FilterAddressPicker
          value={from || null}
          onChange={(v) => setFrom(v ?? '')}
          close={close}
        />
      ),
    },
    {
      id: 'to',
      label: 'To',
      icon: AtSign,
      value: to || null,
      onChange: (next) => setTo(typeof next === 'string' ? next : ''),
      render: ({ close }) => (
        <FilterAddressPicker value={to || null} onChange={(v) => setTo(v ?? '')} close={close} />
      ),
    },
  ];

  return (
    <PageCard title="Messages" description="Inbound + outbound message log." decorative>
      <FilterBar
        filters={filterSpecs}
        search={{ value: q, onChange: setQ, placeholder: 'Search subject or from-address' }}
      />

      {query.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : query.error ? (
        <ErrorText error={query.error} />
      ) : (query.data?.data ?? []).length === 0 ? (
        <EmptyState
          title="No messages match these filters"
          description="Try clearing filters or expanding the time range."
        />
      ) : (
        <>
          <div className="overflow-x-auto">
            <Table>
              <caption className="sr-only">
                Inbound and outbound messages with status, addresses and subject.
              </caption>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[8rem]">Sent</TableHead>
                  <TableHead className="w-[5rem]">Dir</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead className="w-[7rem]">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(query.data?.data ?? []).map((m) => {
                  const terminal = m.status === 'failed' || m.status === 'bounced';
                  return (
                    <TableRow
                      key={m.id}
                      onClick={(e) => {
                        // Programmatic navigate on row click; skip if the
                        // operator was already targeting an interactive
                        // element (the subject Link, a future inline action,
                        // or a text selection).
                        const target = e.target as HTMLElement;
                        if (target.closest('a,button')) return;
                        if (window.getSelection()?.toString()) return;
                        void navigate({ to: '/messages/$id', params: { id: m.id } });
                      }}
                      className={cn(
                        'cursor-pointer text-sm hover:bg-[var(--color-accent)]/40',
                        terminal ? 'border-l-2 border-l-[var(--color-destructive)]' : null,
                      )}
                    >
                      <TableCell className="py-2 whitespace-nowrap text-xs text-[var(--color-muted-foreground)]">
                        {m.created_at ? formatRelative(m.created_at) : '—'}
                      </TableCell>
                      <TableCell className="py-2">
                        <StatusBadge kind="direction" value={m.direction} />
                      </TableCell>
                      <TableCell
                        className="max-w-xs truncate py-2 font-mono text-xs"
                        title={m.from}
                      >
                        {m.from}
                      </TableCell>
                      <TableCell
                        className="max-w-xs truncate py-2 font-mono text-xs"
                        title={m.to?.join(', ')}
                      >
                        {m.to?.join(', ')}
                      </TableCell>
                      <TableCell className="py-2 text-sm">
                        <Link
                          to="/messages/$id"
                          params={{ id: m.id }}
                          className="font-medium text-[var(--color-foreground)] underline-offset-2 hover:underline"
                        >
                          {m.subject ?? (
                            <span className="italic text-[var(--color-muted-foreground)]">
                              (no subject)
                            </span>
                          )}
                        </Link>
                      </TableCell>
                      <TableCell className="py-2">
                        <StatusBadge kind="message" value={m.status} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <div className="mt-4 flex items-center justify-between">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={query.data?.next_offset == null}
              onClick={() => query.data?.next_offset != null && setOffset(query.data.next_offset)}
            >
              Next
            </Button>
          </div>
        </>
      )}
    </PageCard>
  );
}
