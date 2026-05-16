// Diagnostics page — operator-facing system health overview.
//
// Cards:
//  - Panel-side health checks (api healthz, audit chain, tenants listable —
//    backed by the existing GET /api/diagnostics route on the panel server).
//  - DLQ depth / recent failures (24h) from the dashboard's stats overview,
//    linking into the DLQ browser.
//  - Last audit anchor / chain status from GET /api/audit/chain-status, with
//    a link into the audit log on the account page.
//  - Panel /healthz liveness ping.
//
// Cards render an "unavailable" placeholder when the backing query errors
// rather than throwing — the goal is for the page to remain useful even
// when one source is degraded.
import { Link } from '@tanstack/react-router';
import { PageCard } from '../../layouts/PageCard.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/card.js';
import { Badge } from '../../components/ui/badge.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { useAdminQuery } from '../../hooks/useAdminApi.js';
import { bridgeKeys, diagnosticsKeys, dlqKeys, statsKeys } from '../../queryKeys.js';
import { formatDate, formatRelative } from '../../lib/format.js';

interface DiagCheck {
  name: string;
  ok: boolean;
  detail?: string;
}
interface DiagnosticsPayload {
  ok: boolean;
  checks: DiagCheck[];
}

interface ChainStatus {
  head?: { id?: number; created_at?: string; hash?: string };
  count?: number;
  ok?: boolean;
}

interface StatsOverview {
  dlq_depth: number;
  messages: {
    failed: number;
    bounced: number;
  };
}

interface HealthzPayload {
  ok: boolean;
  // Some panel deployments embed the build SHA in /healthz so the operator
  // can confirm which revision is serving without shelling into the worker.
  // Optional — older deploys won't populate this.
  build_sha?: string;
  version?: string;
}

interface BridgeRow {
  id: string;
  name: string;
  last_seen_at: string | null;
  disabled_at: string | null;
}

interface DlqRow {
  id: string;
  message_id: string | null;
  webhook_sub_id: string;
  attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  dlq_at: string;
}

interface QueueDepths {
  // Anticipated payload from a future GET /v1/admin/queues. Until that
  // endpoint exists, this card will render the "unavailable" placeholder.
  // Shape kept generic so the card can survive shape evolution.
  data?: { name: string; depth: number; in_flight?: number }[];
}

function Unavailable({ message }: { message?: string }) {
  return (
    <p className="text-xs text-[var(--color-muted-foreground)]">{message ?? 'Data unavailable.'}</p>
  );
}

function HealthCard() {
  const q = useAdminQuery<DiagnosticsPayload>(diagnosticsKeys.panel(), '/api/diagnostics');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Health checks</CardTitle>
        <CardDescription>Panel → API → audit chain reachability.</CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : q.error ? (
          <Unavailable message={q.error.message} />
        ) : !q.data ? (
          <Unavailable />
        ) : (
          <ul className="space-y-1 text-sm">
            {q.data.checks.map((c) => (
              <li key={c.name} className="flex items-center gap-2">
                {c.ok ? (
                  <Badge variant="success">ok</Badge>
                ) : (
                  <Badge variant="destructive">fail</Badge>
                )}
                <span className="font-mono text-xs">{c.name}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function PanelLivenessCard() {
  const q = useAdminQuery<HealthzPayload>(diagnosticsKeys.health(), '/healthz');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Panel liveness</CardTitle>
        <CardDescription>GET /healthz</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {q.isLoading ? (
            <Skeleton className="h-8 w-24" />
          ) : q.error ? (
            <Badge variant="destructive">down</Badge>
          ) : q.data?.ok ? (
            <Badge variant="success">up</Badge>
          ) : (
            <Badge variant="secondary">unknown</Badge>
          )}
          {q.data?.build_sha || q.data?.version ? (
            <div className="font-mono text-xs text-[var(--color-muted-foreground)]">
              {q.data.version ? `v${q.data.version} · ` : ''}
              {q.data.build_sha ? q.data.build_sha.slice(0, 12) : ''}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function BridgesCard() {
  const q = useAdminQuery<{ data: BridgeRow[] }>(bridgeKeys.list(), '/api/admin/bridges');
  // "Online" is best-effort: a bridge with no last_seen_at OR a stale one
  // (>5min) is treated as offline. The bridge daemon heartbeats on a much
  // tighter cadence than that, so 5min is well into "actually broken".
  const STALE_MS = 5 * 60_000;
  const rows = q.data?.data ?? [];
  const active = rows.filter((b) => !b.disabled_at);
  const online = active.filter(
    (b) => b.last_seen_at && Date.now() - new Date(b.last_seen_at).getTime() < STALE_MS,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Bridges</CardTitle>
        <CardDescription>
          On-prem bridges currently heartbeating.{' '}
          <Link to="/bridges" className="underline">
            View bridges
          </Link>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : q.error ? (
          <Unavailable message={q.error.message} />
        ) : active.length === 0 ? (
          <Unavailable message="No bridges registered." />
        ) : (
          <div className="flex flex-wrap gap-3 text-sm">
            <span>
              Online{' '}
              <Badge variant={online.length === active.length ? 'success' : 'warning'}>
                {online.length}/{active.length}
              </Badge>
            </span>
            {online.length < active.length ? (
              <span className="text-xs text-[var(--color-muted-foreground)]">
                stale &gt; 5min
              </span>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RecentFailuresCard() {
  // Recent webhook failures are surfaced from the DLQ — the most useful
  // incident-triage signal is "what's been failing in the last hour".
  const q = useAdminQuery<{ data: DlqRow[] }>(
    diagnosticsKeys.recentFailures(),
    '/api/admin/webhook-dlq',
  );
  const HOUR_MS = 60 * 60_000;
  const recent = (q.data?.data ?? []).filter(
    (r) => Date.now() - new Date(r.dlq_at).getTime() < HOUR_MS,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent webhook failures (1h)</CardTitle>
        <CardDescription>
          Latest entries on the dead-letter queue.{' '}
          <Link to="/dlq" className="underline">
            Browse DLQ
          </Link>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : q.error ? (
          <Unavailable message={q.error.message} />
        ) : recent.length === 0 ? (
          <p className="text-xs text-[var(--color-muted-foreground)]">
            No failures in the last hour.
          </p>
        ) : (
          <ul className="space-y-1 text-xs">
            {recent.slice(0, 5).map((r) => (
              <li key={r.id} className="flex items-center gap-2">
                {r.last_status_code ? (
                  <Badge variant="destructive">{r.last_status_code}</Badge>
                ) : (
                  <Badge variant="outline">err</Badge>
                )}
                <span className="font-mono">{r.webhook_sub_id.slice(0, 10)}…</span>
                <span
                  className="ml-auto text-[var(--color-muted-foreground)]"
                  title={formatDate(r.dlq_at)}
                >
                  {formatRelative(r.dlq_at)}
                </span>
              </li>
            ))}
            {recent.length > 5 ? (
              <li className="text-[var(--color-muted-foreground)]">
                +{recent.length - 5} more
              </li>
            ) : null}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function QueueDepthsCard() {
  // Wired to a hypothetical /v1/admin/queues endpoint. The card degrades to
  // "unavailable" until the upstream API exposes it; once it lands we get
  // queue visibility for free without touching this component.
  const q = useAdminQuery<QueueDepths>(diagnosticsKeys.queues(), '/api/admin/queues');
  const rows = q.data?.data ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Queue depths</CardTitle>
        <CardDescription>Submission, retry, webhook fan-out queues.</CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : q.error ? (
          <Unavailable message={q.error.message} />
        ) : rows.length === 0 ? (
          <Unavailable message="No queue telemetry available." />
        ) : (
          <ul className="space-y-1 text-xs">
            {rows.map((q) => (
              <li key={q.name} className="flex items-center gap-2">
                <span className="font-mono">{q.name}</span>
                <Badge variant={q.depth > 0 ? 'warning' : 'secondary'}>{q.depth}</Badge>
                {q.in_flight != null ? (
                  <span className="text-[var(--color-muted-foreground)]">
                    in-flight {q.in_flight}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// Suppress the unused-import warning for dlqKeys — kept exported via
// queryKeys.ts and used by other pages, but the diagnostics card uses
// `diagnosticsKeys.recentFailures()` so the dlq query stays cache-distinct
// from the DLQ browser page (different filters).
void dlqKeys;

function DlqCard() {
  // Reuse the stats overview the dashboard already consumes — keeps the
  // surface area small. If that endpoint isn't available the card degrades
  // to "unavailable" rather than breaking the page.
  const q = useAdminQuery<StatsOverview>(
    statsKeys.overview('24h'),
    '/api/admin/stats/overview?window=24h',
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>DLQ & failures (24h)</CardTitle>
        <CardDescription>
          Failed/bounced message volume + dead-letter depth.{' '}
          <Link to="/dlq" className="underline">
            Browse DLQ
          </Link>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : q.error ? (
          <Unavailable message={q.error.message} />
        ) : !q.data ? (
          <Unavailable />
        ) : (
          <div className="flex flex-wrap gap-4 text-sm">
            <span>
              DLQ depth <Badge variant="secondary">{q.data.dlq_depth}</Badge>
            </span>
            <span>
              Failed <Badge variant="destructive">{q.data.messages.failed}</Badge>
            </span>
            <span>
              Bounced <Badge variant="outline">{q.data.messages.bounced}</Badge>
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AuditAnchorCard() {
  const q = useAdminQuery<ChainStatus>(diagnosticsKeys.auditAnchor(), '/api/audit/chain-status');
  const head = q.data?.head;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit chain</CardTitle>
        <CardDescription>
          Last anchored entry.{' '}
          <Link to="/settings/account" className="underline">
            View audit log
          </Link>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : q.error ? (
          <Unavailable message={q.error.message} />
        ) : !head ? (
          <Unavailable message="No anchor seen yet." />
        ) : (
          <div className="space-y-1 text-sm">
            <div>
              head id <Badge variant="secondary">{head.id ?? '—'}</Badge>
            </div>
            {head.created_at ? (
              <div
                className="text-xs text-[var(--color-muted-foreground)]"
                title={formatDate(head.created_at)}
              >
                anchored {formatRelative(head.created_at)}
              </div>
            ) : null}
            {head.hash ? (
              <div className="break-all font-mono text-xs text-[var(--color-muted-foreground)]">
                hash {head.hash.slice(0, 16)}…
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function Diagnostics() {
  return (
    <PageCard
      title="Diagnostics"
      description="System health at a glance. Each card polls its own backing endpoint and degrades gracefully when a source is unavailable."
      decorative
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <HealthCard />
        <PanelLivenessCard />
        <BridgesCard />
        <QueueDepthsCard />
        <DlqCard />
        <RecentFailuresCard />
        <AuditAnchorCard />
      </div>
    </PageCard>
  );
}
