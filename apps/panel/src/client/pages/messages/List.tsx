// Messages list — filters → GET /v1/messages.
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { PageCard } from '../../layouts/PageCard.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Button } from '../../components/ui/button.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { useAdminQuery } from '../../hooks/useAdminApi.js';
import { messageKeys } from '../../queryKeys.js';

interface MessageRow {
  id: string;
  direction: 'in' | 'out';
  status: string;
  from: string;
  to: string[];
  subject?: string;
  created_at?: string;
}

export function MessagesList() {
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

  return (
    <PageCard title="Messages" description="Inbound + outbound message log." decorative>
      <div className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-4">
        <div>
          <Label>Direction</Label>
          <Select
            value={direction || 'any'}
            onValueChange={(v) => setDirection(v === 'any' ? '' : v)}
          >
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              <SelectItem value="in">in</SelectItem>
              <SelectItem value="out">out</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Status</Label>
          <Select value={status || 'any'} onValueChange={(v) => setStatus(v === 'any' ? '' : v)}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              {['queued', 'sending', 'sent', 'delivered', 'failed', 'bounced', 'received'].map(
                (s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="from">From</Label>
          <Input id="from" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="to">To</Label>
          <Input id="to" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="since">Since</Label>
          <Input id="since" type="date" value={since} onChange={(e) => setSince(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="until">Until</Label>
          <Input id="until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="q">Search</Label>
          <Input
            id="q"
            placeholder="subject or from-address"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      {query.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : query.error ? (
        <p className="text-sm text-[var(--color-destructive)]">{query.error.message}</p>
      ) : (query.data?.data ?? []).length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">No messages found.</p>
      ) : (
        <>
          {/* The messages list scrolls horizontally on narrow viewports
              because the Subject column is unbounded. The first column (ID)
              gets `sticky left-0` so the row identity stays visible while
              the operator scrolls right. (Phase 6b.5) */}
          <div className="overflow-x-auto">
            <Table>
              <caption className="sr-only">
                Inbound and outbound messages with status, addresses and subject.
              </caption>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 z-10 bg-[var(--color-card)]">ID</TableHead>
                  <TableHead>Direction</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(query.data?.data ?? []).map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="sticky left-0 z-10 bg-[var(--color-card)] font-mono text-xs">
                      <Link to="/messages/$id" params={{ id: m.id }} className="underline">
                        {m.id.slice(0, 10)}…
                      </Link>
                    </TableCell>
                    <TableCell>{m.direction}</TableCell>
                    <TableCell className="font-mono text-xs">{m.from}</TableCell>
                    <TableCell className="font-mono text-xs">{m.to?.join(', ')}</TableCell>
                    <TableCell>{m.subject ?? '(no subject)'}</TableCell>
                    <TableCell>
                      <StatusBadge kind="message" value={m.status} />
                    </TableCell>
                  </TableRow>
                ))}
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
