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
import { diagnosticsKeys, statsKeys } from '../../queryKeys.js';

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
        {q.isLoading ? (
          <Skeleton className="h-8 w-24" />
        ) : q.error ? (
          <Badge variant="destructive">down</Badge>
        ) : q.data?.ok ? (
          <Badge variant="success">up</Badge>
        ) : (
          <Badge variant="secondary">unknown</Badge>
        )}
      </CardContent>
    </Card>
  );
}

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
              <div className="text-xs text-[var(--color-muted-foreground)]">
                anchored {head.created_at}
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
        <DlqCard />
        <AuditAnchorCard />
      </div>
    </PageCard>
  );
}
