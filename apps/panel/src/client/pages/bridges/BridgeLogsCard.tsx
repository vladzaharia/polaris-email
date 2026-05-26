// BridgeLogsCard — Logs tab on the bridge Detail page.
//
// Pulls log lines from GET /api/admin/bridges/:id/logs. Auto-refreshes
// every 5s while the tab is active. The bridge ships its log delta in
// each heartbeat (every 60s default), so the panel sees fresh lines
// within ~60s of them being emitted on the host.
import { useState } from 'react';
import { Clock, RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { ErrorText } from '../../components/ErrorText.js';
import { useAdminQuery } from '../../hooks/useAdminApi.js';
import { formatDate, formatRelative } from '../../lib/format.js';

interface LogLine {
  seq: number;
  at: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
}

interface LogsResponse {
  bridge_id: string;
  order: 'asc' | 'desc';
  limit: number;
  lines: LogLine[];
  next_cursor: string | null;
}

interface BridgeLogsCardProps {
  bridgeId: string;
}

const LIMIT_OPTIONS = ['200', '500', '1000', '2000'];

export function BridgeLogsCard({ bridgeId }: BridgeLogsCardProps) {
  const [limit, setLimit] = useState('500');
  const [autoRefresh, setAutoRefresh] = useState(true);

  const q = useAdminQuery<LogsResponse>(
    ['bridges', bridgeId, 'logs', limit],
    `/api/admin/bridges/${bridgeId}/logs?limit=${limit}&order=desc`,
    autoRefresh ? { refetchInterval: 5000 } : {},
  );

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">Bridge logs</h2>
        <span className="text-xs text-[var(--color-muted-foreground)]">
          Tail forwarded via heartbeat (~60s lag). Newest first.
        </span>
        <span className="ml-auto inline-flex items-center gap-2">
          <Select value={limit} onValueChange={setLimit}>
            <SelectTrigger className="h-8 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIMIT_OPTIONS.map((n) => (
                <SelectItem key={n} value={n}>
                  Last {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAutoRefresh((v) => !v)}
            aria-pressed={autoRefresh}
          >
            <Clock className="h-3.5 w-3.5" aria-hidden />
            {autoRefresh ? 'Auto-refresh on' : 'Auto-refresh off'}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
            <RefreshCw
              className={`h-3.5 w-3.5 ${q.isFetching ? 'animate-spin' : ''}`}
              aria-hidden
            />
            Refresh
          </Button>
        </span>
      </div>

      <ErrorText error={q.error} />

      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.data && q.data.lines.length > 0 ? (
        <div className="max-h-[600px] overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-card)]">
          <table className="w-full font-mono text-xs">
            <tbody>
              {q.data.lines.map((l, i) => (
                <tr
                  key={`${l.at}-${l.seq}-${i}`}
                  className="border-b border-[var(--color-border)] last:border-0"
                >
                  <td
                    className="whitespace-nowrap px-2 py-1 align-top text-[var(--color-muted-foreground)]"
                    title={formatDate(l.at)}
                  >
                    {formatRelative(l.at)}
                  </td>
                  <td className="px-2 py-1 align-top">
                    <span className={`${levelColor(l.level)} font-semibold uppercase`}>
                      {l.level}
                    </span>
                  </td>
                  <td className="px-2 py-1 align-top">
                    <pre className="whitespace-pre-wrap break-words">{l.msg}</pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-muted-foreground)]">
          No logs forwarded yet. The bridge ships log lines in each heartbeat — wait ~60s after
          first connection.
        </p>
      )}
    </section>
  );
}

function levelColor(level: LogLine['level']): string {
  switch (level) {
    case 'error':
      return 'text-[var(--color-destructive)]';
    case 'warn':
      return 'text-[var(--color-warning)]';
    case 'debug':
      return 'text-[var(--color-muted-foreground)]';
    default:
      return 'text-[var(--color-foreground)]';
  }
}
