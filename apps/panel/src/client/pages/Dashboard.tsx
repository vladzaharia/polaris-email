/*
 * Dashboard — complete rewrite, post-SRE-console era.
 *
 * --- Critique of the previous layout (kept here so the next rewrite has the
 * --- context for why we tore it down): -------------------------------------
 *
 * The previous Dashboard read like an on-call console. Four `StatusPill`
 * cards sat at the top in a uniform row — each one the same width, same
 * weight, same colour, same shape — so the eye had nowhere to land. The
 * NextActionCard floated next to them as just another rectangle. Below
 * that, six PanelCards stacked in a 2x3 grid, all the same size; "Recent
 * alerts" and "Bridges" carried the same visual weight as "Synthetic
 * checks" even when synthetics had nothing to say. The Volume Tabs lived at
 * the bottom of the page, demoted to a footnote, with eleven StatCards
 * crammed into a single grid of nearly-identical 24px headlines. Three
 * problems with that: (a) there was no headline — when you opened the
 * page, no single fact jumped out, you had to scan; (b) volume (the actual
 * outcome — "did we deliver mail today?") was less prominent than
 * cardinality counts ("we have 3 webhook subs"); (c) the colour palette
 * was applied uniformly through `Badge` variants, so every panel shouted
 * the same green/amber/red intensity even when only one of them mattered.
 * The page felt comprehensive but never confident. This rewrite inverts
 * the hierarchy: one headline, a slim health strip, a 2-column activity-
 * feed-led card grid, and the cardinality counts moved into a quiet
 * footer where they belong. Colour is reserved for outliers.
 * --------------------------------------------------------------------------
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  BellRing,
  CheckCircle2,
  Flag,
  Globe2,
  Inbox,
  Minus,
  Send,
  Server,
  ServerCrash,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Webhook,
} from 'lucide-react';
import { PageCard } from '../layouts/PageCard.js';
import { Card, CardContent } from '../components/ui/card.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Skeleton } from '../components/ui/skeleton.js';
import { EmptyState } from '../components/EmptyState.js';
import { SegmentedControl } from '../components/SegmentedControl.js';
import { useAdminQuery } from '../hooks/useAdminApi.js';
import {
  abuseEventKeys,
  adminAlertKeys,
  bridgeKeys,
  dlqKeys,
  domainKeys,
  senderAbuseKeys,
  statsKeys,
  syntheticKeys,
  auditKeys,
} from '../queryKeys.js';
import { formatRelative } from '../lib/format.js';
import { cn } from '../lib/cn.js';

// ---------- shared API shapes ----------

interface StatsOverview {
  window: '24h' | '7d' | '30d';
  cardinality: {
    mailboxes: number;
    domains_verified: number;
    domains_pending: number;
    domains_failed: number;
    senders: number;
    credentials_api_key: number;
    credentials_smtp: number;
    webhook_subs: number;
  };
  messages: {
    sent: number;
    delivered: number;
    failed: number;
    bounced: number;
    inbound_received: number;
  };
  dlq_depth: number;
}

interface BridgeRow {
  id: string;
  name: string;
  last_seen_at: string | null;
  created_at?: string;
  disabled_at: string | null;
}

interface SyntheticRow {
  check_kind: string;
  total: number;
  passes: number;
  avg_latency_ms?: number;
  latest_at?: string;
}

interface ChainStatus {
  head?: { id?: number; created_at?: string; hash?: string };
  count?: number;
  ok?: boolean;
}

interface AlertRow {
  id: string;
  alert_type: string;
  severity: 'info' | 'warn' | 'critical';
  target: string;
  subject: string;
  created_at: string;
}

interface AbuseEventRow {
  id: string;
  sender_address: string | null;
  classification: string;
  reporter_address: string | null;
  reporter_org: string | null;
  reported_at: string;
}

interface DlqRow {
  id: string;
  webhook_sub_id: string;
  webhook_url?: string | null;
  attempts: number;
  last_status_code: number | null;
  dlq_at: string;
}

interface DomainRow {
  id: string;
  name: string;
  status: 'pending' | 'verified' | 'failed' | 'disabled' | string;
  created_at?: string;
  updated_at?: string;
}

interface SenderProfileRow {
  principal_type: 'sender_address' | 'mailbox' | 'domain';
  principal_id: string;
  current_tier: number;
  last_event_at: string | null;
}

// ---------- helpers ----------

const TWO_MIN_MS = 2 * 60_000;
const TEN_MIN_MS = 10 * 60_000;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

type WindowKey = '24h' | '7d' | '30d';

function windowDays(w: WindowKey): number {
  return w === '24h' ? 1 : w === '7d' ? 7 : 30;
}

function windowLabel(w: WindowKey): string {
  return w === '24h' ? 'today' : w === '7d' ? 'this week' : 'this month';
}

function comparisonWindow(w: WindowKey): WindowKey {
  return w === '24h' ? '7d' : w === '7d' ? '30d' : '30d';
}

function ageMs(ts: string | null | undefined): number {
  if (!ts) return Number.POSITIVE_INFINITY;
  const d = new Date(ts).getTime();
  if (!Number.isFinite(d)) return Number.POSITIVE_INFINITY;
  return Date.now() - d;
}

function failedRate(s: StatsOverview | undefined): number {
  if (!s) return 0;
  const total = s.messages.sent + s.messages.failed;
  if (total <= 0) return 0;
  return s.messages.failed / total;
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US');
}

function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString('en-US');
}

// ---------- Tone (used by inline pills / cards) ----------

type Tone = 'nominal' | 'soft' | 'warning' | 'critical' | 'neutral';

const toneAccent: Record<Tone, string> = {
  nominal: 'text-[var(--color-success)]',
  soft: 'text-[var(--color-muted-foreground)]',
  warning: 'text-[var(--color-warning)]',
  critical: 'text-[var(--color-destructive)]',
  neutral: 'text-[var(--color-muted-foreground)]',
};

const toneDot: Record<Tone, string> = {
  nominal: 'bg-[var(--color-success)]',
  soft: 'bg-[var(--color-muted-foreground)]',
  warning: 'bg-[var(--color-warning)]',
  critical: 'bg-[var(--color-destructive)]',
  neutral: 'bg-[var(--color-muted-foreground)]',
};

// ---------- Headline KPI: delivered, with trend vs prior period ----------

interface HeadlineDerived {
  delivered: number;
  attempted: number;
  successRate: number;
  trendPct: number | null; // null = no comparison available
  trendArrow: 'up' | 'down' | 'flat';
}

function deriveHeadline(
  current: StatsOverview | undefined,
  comparison: StatsOverview | undefined,
  window: WindowKey,
): HeadlineDerived {
  if (!current) {
    return {
      delivered: 0,
      attempted: 0,
      successRate: 0,
      trendPct: null,
      trendArrow: 'flat',
    };
  }
  const delivered = current.messages.delivered;
  const attempted = current.messages.sent + current.messages.failed;
  const successRate = attempted === 0 ? 1 : current.messages.delivered / attempted;

  // Build a same-length prior period by subtracting the current window from
  // the next-longer window, then normalising to the current window's day-
  // count. This is intentionally a heuristic — there is no per-day endpoint
  // — and it degrades to `null` when comparison data is missing.
  let trendPct: number | null = null;
  if (comparison && comparison.window !== window) {
    const compDays = windowDays(comparison.window);
    const curDays = windowDays(window);
    const remainderDays = compDays - curDays;
    if (remainderDays > 0) {
      const prevDeliveredPerCurWindow =
        ((comparison.messages.delivered - delivered) / remainderDays) * curDays;
      if (prevDeliveredPerCurWindow > 0) {
        trendPct = ((delivered - prevDeliveredPerCurWindow) / prevDeliveredPerCurWindow) * 100;
      } else if (delivered > 0) {
        trendPct = 100;
      } else {
        trendPct = 0;
      }
    }
  }
  const trendArrow: HeadlineDerived['trendArrow'] =
    trendPct == null || Math.abs(trendPct) < 1 ? 'flat' : trendPct > 0 ? 'up' : 'down';
  return { delivered, attempted, successRate, trendPct, trendArrow };
}

// ---------- Next-action rule engine (carried over, slimmed) ----------

interface NextAction {
  tone: Tone;
  icon: typeof ShieldAlert;
  text: string;
  cta?: { label: string; to: string };
}

interface NextActionInput {
  stats: StatsOverview | undefined;
  bridges: BridgeRow[] | undefined;
  synthetics: SyntheticRow[] | undefined;
  chain: ChainStatus | undefined;
  alerts: AlertRow[] | undefined;
  domains: DomainRow[] | undefined;
  senders: SenderProfileRow[] | undefined;
  dlq: DlqRow[] | undefined;
}

function chooseNextAction(s: NextActionInput): NextAction {
  // Audit chain failed — block on this above all else.
  if (s.chain && (s.chain.head?.id == null || s.chain.head.id < 0)) {
    return {
      tone: 'critical',
      icon: ShieldAlert,
      text: 'Audit chain verification failed.',
      cta: { label: 'Open diagnostics', to: '/diagnostics' },
    };
  }
  const bridges = s.bridges ?? [];
  const activeBridges = bridges.filter((b) => !b.disabled_at);
  if (s.bridges && activeBridges.length === 0) {
    return {
      tone: 'critical',
      icon: ServerCrash,
      text: 'No active bridges. Inbound IMAP delivery is offline.',
      cta: { label: 'Open bridges', to: '/bridges' },
    };
  }
  const stale = activeBridges.find((b) => ageMs(b.last_seen_at) > TEN_MIN_MS);
  if (stale) {
    const mins = Math.round(ageMs(stale.last_seen_at) / 60_000);
    return {
      tone: 'critical',
      icon: ServerCrash,
      text: `Bridge ${stale.name} silent for ${mins}m.`,
      cta: { label: 'Open bridge', to: `/bridges/${stale.id}` },
    };
  }
  const rate = failedRate(s.stats);
  const dlqDepth = s.stats?.dlq_depth ?? s.dlq?.length ?? 0;
  if (dlqDepth > 100 || rate > 0.05) {
    return {
      tone: 'critical',
      icon: Inbox,
      text:
        dlqDepth > 100
          ? `Webhook DLQ at ${dlqDepth}. Drain or replay.`
          : `Webhook failure rate at ${(rate * 100).toFixed(1)}%.`,
      cta: { label: 'Open DLQ', to: '/dlq' },
    };
  }
  if (s.synthetics && s.synthetics.length > 0) {
    const failing = s.synthetics
      .map((r) => ({ ...r, pct: r.total === 0 ? 0 : (r.passes / r.total) * 100 }))
      .filter((r) => r.pct < 90)
      .sort((a, b) => a.pct - b.pct)[0];
    if (failing) {
      return {
        tone: 'critical',
        icon: Activity,
        text: `Synthetic '${failing.check_kind}' at ${failing.pct.toFixed(0)}% — likely customer-visible.`,
        cta: { label: 'Run diagnostics', to: '/diagnostics' },
      };
    }
  }
  const criticalAlerts =
    s.alerts?.filter((a) => a.severity === 'critical' && ageMs(a.created_at) < DAY_MS) ?? [];
  if (criticalAlerts.length > 0) {
    const latest = criticalAlerts[0]!;
    return {
      tone: 'critical',
      icon: BellRing,
      text: `${criticalAlerts.length} critical alert${criticalAlerts.length === 1 ? '' : 's'}: ${latest.subject}`,
      cta: { label: 'View alerts', to: '/abuse?tab=alerts' },
    };
  }
  if (dlqDepth > 0) {
    return {
      tone: 'warning',
      icon: Webhook,
      text: `Replay ${dlqDepth} dead-lettered webhook ${dlqDepth === 1 ? 'delivery' : 'deliveries'}.`,
      cta: { label: 'Open DLQ', to: '/dlq' },
    };
  }
  const failedDomain = s.domains?.find((d) => d.status === 'failed');
  if (failedDomain) {
    return {
      tone: 'warning',
      icon: Globe2,
      text: `Domain ${failedDomain.name} failed verification.`,
      cta: { label: 'Open domain', to: `/domains/${failedDomain.id}` },
    };
  }
  const escalated = s.senders
    ?.filter((p) => p.current_tier >= 2 && ageMs(p.last_event_at) < DAY_MS)
    .sort((a, b) => b.current_tier - a.current_tier)[0];
  if (escalated) {
    return {
      tone: 'warning',
      icon: Flag,
      text: `${escalated.principal_id} escalated to tier ${escalated.current_tier}.`,
      cta: { label: 'Open senders', to: '/abuse?tab=senders' },
    };
  }
  if (rate >= 0.01) {
    return {
      tone: 'soft',
      icon: AlertTriangle,
      text: `Soft failure rate elevated (${(rate * 100).toFixed(1)}%).`,
      cta: { label: 'Open messages', to: '/messages' },
    };
  }
  return {
    tone: 'nominal',
    icon: CheckCircle2,
    text: 'All systems nominal.',
    cta: { label: 'Send a message', to: '/mailboxes' },
  };
}

// ---------- Headline ----------

function TrendChip({
  trend,
  arrow,
  compactWindow,
}: {
  trend: number | null;
  arrow: 'up' | 'down' | 'flat';
  compactWindow: string;
}) {
  if (trend == null) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-[var(--color-muted-foreground)]">
        <Minus className="h-3 w-3" aria-hidden /> no prior period
      </span>
    );
  }
  const Icon = arrow === 'up' ? ArrowUpRight : arrow === 'down' ? ArrowDownRight : Minus;
  const colour =
    arrow === 'flat'
      ? 'text-[var(--color-muted-foreground)]'
      : arrow === 'up'
        ? 'text-[var(--color-success)]'
        : 'text-[var(--color-destructive)]';
  const sign = trend > 0 ? '+' : '';
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium', colour)}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      <span>
        {sign}
        {trend.toFixed(0)}%
      </span>
      <span className="font-normal text-[var(--color-muted-foreground)]">vs {compactWindow}</span>
    </span>
  );
}

function HeadlineKPI({
  window,
  onWindowChange,
  current,
  comparison,
  loading,
}: {
  window: WindowKey;
  onWindowChange: (w: WindowKey) => void;
  current: StatsOverview | undefined;
  comparison: StatsOverview | undefined;
  loading: boolean;
}) {
  const h = deriveHeadline(current, comparison, window);
  const successPct = (h.successRate * 100).toFixed(h.successRate >= 0.999 ? 1 : 2);
  const priorLabel =
    window === '24h' ? 'prior day' : window === '7d' ? 'prior week' : 'prior month';

  return (
    <div
      className="relative overflow-hidden rounded-xl bg-[var(--color-card)] p-6 ring-1 ring-[var(--color-border)]/60 sm:p-8"
      style={{
        backgroundImage:
          'radial-gradient(120% 80% at 100% 0%, color-mix(in oklch, var(--color-primary) 8%, transparent), transparent 60%)',
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-[var(--color-muted-foreground)]">
            Messages delivered · {windowLabel(window)}
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-2">
            {loading ? (
              <Skeleton className="h-12 w-48" />
            ) : (
              <span className="text-5xl font-semibold tracking-tight tabular-nums sm:text-6xl">
                {formatNumber(h.delivered)}
              </span>
            )}
            {!loading ? (
              <TrendChip trend={h.trendPct} arrow={h.trendArrow} compactWindow={priorLabel} />
            ) : null}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-[var(--color-muted-foreground)]">
            <span className="inline-flex items-center gap-1.5">
              <Send className="h-3.5 w-3.5" aria-hidden />
              {loading ? '—' : formatNumber(h.attempted)} attempted
            </span>
            <span aria-hidden className="text-[var(--color-border)]">
              ·
            </span>
            <span className="inline-flex items-center gap-1.5 tabular-nums">
              {loading ? '—' : `${successPct}% delivered`}
            </span>
            {current ? (
              <>
                <span aria-hidden className="text-[var(--color-border)]">
                  ·
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Inbox className="h-3.5 w-3.5" aria-hidden />
                  {formatCompact(current.messages.inbound_received)} inbound
                </span>
              </>
            ) : null}
          </div>
        </div>
        <WindowSwitcher value={window} onChange={onWindowChange} />
      </div>
    </div>
  );
}

function WindowSwitcher({
  value,
  onChange,
}: {
  value: WindowKey;
  onChange: (w: WindowKey) => void;
}) {
  return (
    <SegmentedControl<WindowKey>
      ariaLabel="Time window"
      size="sm"
      options={[
        { value: '24h', label: '24h' },
        { value: '7d', label: '7 days' },
        { value: '30d', label: '30 days' },
      ]}
      value={value}
      onChange={onChange}
    />
  );
}

// ---------- Next-action banner (slim, single-line where possible) ----------

function NextActionBanner({ action }: { action: NextAction }) {
  const Icon = action.icon;
  const bg =
    action.tone === 'critical'
      ? 'color-mix(in oklch, var(--color-destructive) 8%, transparent)'
      : action.tone === 'warning'
        ? 'color-mix(in oklch, var(--color-warning) 12%, transparent)'
        : action.tone === 'nominal'
          ? 'color-mix(in oklch, var(--color-success) 8%, transparent)'
          : 'var(--color-card)';
  const ring =
    action.tone === 'critical'
      ? 'ring-[var(--color-destructive)]/30'
      : action.tone === 'warning'
        ? 'ring-[var(--color-warning)]/40'
        : action.tone === 'nominal'
          ? 'ring-[var(--color-success)]/30'
          : 'ring-[var(--color-border)]/60';

  return (
    <div
      className={cn('flex flex-wrap items-center gap-3 rounded-lg px-4 py-3 text-sm ring-1', ring)}
      style={{ background: bg }}
    >
      <Icon className={cn('h-4 w-4 shrink-0', toneAccent[action.tone])} aria-hidden />
      <span className="min-w-0 flex-1">{action.text}</span>
      {action.cta ? (
        <Button asChild size="sm" variant="outline">
          <Link to={action.cta.to}>
            {action.cta.label}
            <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden />
          </Link>
        </Button>
      ) : null}
    </div>
  );
}

// ---------- Health strip (4 inline compact pills, dot + label, no card chrome) ----------

interface HealthPillSpec {
  label: string;
  value: string;
  tone: Tone;
  to: string;
}

function pipelineHealth(stats: StatsOverview | undefined): HealthPillSpec {
  if (!stats) return { label: 'Pipeline', value: '—', tone: 'neutral', to: '/dlq' };
  const dlq = stats.dlq_depth;
  const rate = failedRate(stats);
  const value = `${formatCompact(dlq)} DLQ · ${(rate * 100).toFixed(1)}%`;
  if (dlq === 0 && rate < 0.01) return { label: 'Pipeline', value, tone: 'nominal', to: '/dlq' };
  if (dlq <= 50 && rate < 0.05) return { label: 'Pipeline', value, tone: 'warning', to: '/dlq' };
  return { label: 'Pipeline', value, tone: 'critical', to: '/dlq' };
}

function bridgesHealth(bridges: BridgeRow[] | undefined): HealthPillSpec {
  if (!bridges) return { label: 'Bridges', value: '—', tone: 'neutral', to: '/bridges' };
  const active = bridges.filter((b) => !b.disabled_at);
  const value = `${active.length}/${bridges.length}`;
  if (active.length === 0)
    return { label: 'Bridges', value: 'none', tone: 'critical', to: '/bridges' };
  const worst = Math.max(...active.map((b) => ageMs(b.last_seen_at)));
  if (worst <= TWO_MIN_MS) return { label: 'Bridges', value, tone: 'nominal', to: '/bridges' };
  if (worst <= TEN_MIN_MS) return { label: 'Bridges', value, tone: 'warning', to: '/bridges' };
  return { label: 'Bridges', value, tone: 'critical', to: '/bridges' };
}

function syntheticsHealth(rows: SyntheticRow[] | undefined): HealthPillSpec {
  if (!rows || rows.length === 0)
    return { label: 'Synthetics', value: '—', tone: 'neutral', to: '/diagnostics' };
  const rates = rows.map((r) => (r.total === 0 ? 100 : (r.passes / r.total) * 100));
  const worst = Math.min(...rates);
  const value = `${rows.length} probe${rows.length === 1 ? '' : 's'}`;
  if (worst >= 99) return { label: 'Synthetics', value, tone: 'nominal', to: '/diagnostics' };
  if (worst >= 90) return { label: 'Synthetics', value, tone: 'warning', to: '/diagnostics' };
  return { label: 'Synthetics', value, tone: 'critical', to: '/diagnostics' };
}

function auditHealth(chain: ChainStatus | undefined): HealthPillSpec {
  if (!chain) return { label: 'Audit chain', value: '—', tone: 'neutral', to: '/diagnostics' };
  const id = chain.head?.id;
  if (typeof id === 'number' && id >= 0) {
    return {
      label: 'Audit chain',
      value: `#${id.toLocaleString('en-US')}`,
      tone: 'nominal',
      to: '/diagnostics',
    };
  }
  return { label: 'Audit chain', value: 'broken', tone: 'critical', to: '/diagnostics' };
}

function HealthPill({ spec, loading }: { spec: HealthPillSpec; loading: boolean }) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-md px-3 py-1.5 ring-1 ring-[var(--color-border)]/40">
        <Skeleton className="h-2 w-2 rounded-full" />
        <Skeleton className="h-3 w-16" />
      </div>
    );
  }
  return (
    <Link
      to={spec.to}
      className="group inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs ring-1 ring-[var(--color-border)]/50 transition-colors hover:bg-[var(--color-accent)]"
    >
      <span
        aria-hidden
        className={cn('h-2 w-2 rounded-full ring-2 ring-[var(--color-card)]', toneDot[spec.tone])}
      />
      <span className="font-medium">{spec.label}</span>
      <span className="text-[var(--color-muted-foreground)] tabular-nums">{spec.value}</span>
    </Link>
  );
}

// ---------- Activity feed (synthesised cross-source stream) ----------

interface ActivityItem {
  id: string;
  tone: Tone;
  icon: typeof BellRing;
  ts: string;
  primary: string;
  secondary?: string;
  to?: string;
}

function buildActivityFeed(input: {
  alerts: AlertRow[] | undefined;
  abuse: AbuseEventRow[] | undefined;
  dlq: DlqRow[] | undefined;
  bridges: BridgeRow[] | undefined;
  domains: DomainRow[] | undefined;
}): ActivityItem[] {
  const items: ActivityItem[] = [];

  for (const a of input.alerts ?? []) {
    items.push({
      id: `alert:${a.id}`,
      tone: a.severity === 'critical' ? 'critical' : a.severity === 'warn' ? 'warning' : 'neutral',
      icon: BellRing,
      ts: a.created_at,
      primary: a.subject,
      secondary: a.alert_type,
      to: '/abuse?tab=alerts',
    });
  }

  for (const r of input.abuse ?? []) {
    items.push({
      id: `abuse:${r.id}`,
      tone:
        r.classification === 'phishing_report' ||
        r.classification === 'legal_takedown' ||
        r.classification === 'virus'
          ? 'critical'
          : 'warning',
      icon: ShieldAlert,
      ts: r.reported_at,
      primary: `${r.classification.replace(/_/g, ' ')} from ${r.sender_address ?? 'unknown'}`,
      secondary: r.reporter_org ?? r.reporter_address ?? undefined,
      to: '/abuse?tab=complaints',
    });
  }

  for (const r of input.dlq ?? []) {
    items.push({
      id: `dlq:${r.id}`,
      tone: (r.last_status_code ?? 0) >= 500 ? 'critical' : 'warning',
      icon: Webhook,
      ts: r.dlq_at,
      primary: `Webhook DLQ — ${r.last_status_code ?? '?'} after ${r.attempts}×`,
      secondary: r.webhook_url ?? r.webhook_sub_id,
      to: '/dlq',
    });
  }

  for (const b of input.bridges ?? []) {
    if (b.disabled_at) {
      items.push({
        id: `bridge-off:${b.id}`,
        tone: 'critical',
        icon: ServerCrash,
        ts: b.disabled_at,
        primary: `Bridge ${b.name} deregistered`,
        to: `/bridges/${b.id}`,
      });
    } else if (b.last_seen_at && ageMs(b.last_seen_at) > TEN_MIN_MS) {
      items.push({
        id: `bridge-stale:${b.id}`,
        tone: 'warning',
        icon: Server,
        ts: b.last_seen_at,
        primary: `Bridge ${b.name} silent`,
        to: `/bridges/${b.id}`,
      });
    }
  }

  for (const d of input.domains ?? []) {
    if (d.status === 'verified' && d.updated_at) {
      items.push({
        id: `dom-ok:${d.id}`,
        tone: 'nominal',
        icon: ShieldCheck,
        ts: d.updated_at,
        primary: `${d.name} verified`,
        to: `/domains/${d.id}`,
      });
    } else if (d.status === 'failed' && d.updated_at) {
      items.push({
        id: `dom-fail:${d.id}`,
        tone: 'critical',
        icon: Globe2,
        ts: d.updated_at,
        primary: `${d.name} failed verification`,
        to: `/domains/${d.id}`,
      });
    }
  }

  // Newest first; cap so the column doesn't grow unbounded.
  return items
    .filter((i) => i.ts)
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    .slice(0, 12);
}

function ActivityFeed({ items, loading }: { items: ActivityItem[]; loading: boolean }) {
  return (
    <div className="rounded-xl bg-[var(--color-card)] ring-1 ring-[var(--color-border)]/40">
      <div className="flex items-center justify-between px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold">Recent activity</h3>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Cross-source signal, newest first.
          </p>
        </div>
        <Sparkles className="h-4 w-4 text-[var(--color-muted-foreground)]" aria-hidden />
      </div>
      <div className="px-5 pb-5">
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState title="Nothing has happened recently." />
        ) : (
          <ol className="relative space-y-3 border-l border-[var(--color-border)]/60 pl-4">
            {items.map((item) => {
              const Icon = item.icon;
              const Tag: typeof Link | 'div' = item.to ? Link : 'div';
              const tagProps = item.to ? { to: item.to } : {};
              return (
                <li key={item.id} className="relative">
                  <span
                    aria-hidden
                    className={cn(
                      'absolute -left-[21px] top-1.5 h-2 w-2 rounded-full ring-2 ring-[var(--color-card)]',
                      toneDot[item.tone],
                    )}
                  />
                  <Tag
                    {...(tagProps as { to: string })}
                    className={cn(
                      'block rounded-md px-2 py-1.5 -mx-2 -my-1.5',
                      item.to ? 'transition-colors hover:bg-[var(--color-accent)]' : '',
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <Icon
                        className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', toneAccent[item.tone])}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm" title={item.primary}>
                          {item.primary}
                        </p>
                        {item.secondary ? (
                          <p
                            className="truncate text-xs text-[var(--color-muted-foreground)]"
                            title={item.secondary}
                          >
                            {item.secondary}
                          </p>
                        ) : null}
                      </div>
                      <span
                        className="shrink-0 text-xs text-[var(--color-muted-foreground)] tabular-nums"
                        title={item.ts}
                      >
                        {formatRelative(item.ts)}
                      </span>
                    </div>
                  </Tag>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}

// ---------- Signal cards (left column) ----------
//
// Intentionally local: the audit recommends extracting `<SignalCard>` so the
// Dashboard visual register is named, but the chrome depends on Dashboard-
// scoped `Tone` + `toneDot` semantics that no other page in the panel uses
// today. Hoisting would force every consumer to import the Dashboard's tone
// vocabulary, which is the opposite of what the audit wanted. If a second
// page ever needs the ring-1/p-5 hero-card recipe, lift this to
// `components/SignalCard.tsx` alongside the tone helpers.
interface SignalCardProps {
  title: string;
  description?: string;
  to: string;
  tone?: Tone;
  loading: boolean;
  empty: boolean;
  emptyTitle: string;
  children?: ReactNode;
  badge?: ReactNode;
}

function SignalCard({
  title,
  description,
  to,
  tone = 'neutral',
  loading,
  empty,
  emptyTitle,
  children,
  badge,
}: SignalCardProps) {
  return (
    <Card className="border-0 bg-[var(--color-card)] shadow-none ring-1 ring-[var(--color-border)]/40">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', toneDot[tone])} />
              {title}
            </h3>
            {description ? (
              <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">{description}</p>
            ) : null}
          </div>
          {badge}
        </div>
        <div className="mt-3">
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-5 w-2/3" />
            </div>
          ) : empty ? (
            <EmptyState title={emptyTitle} />
          ) : (
            children
          )}
        </div>
        <div className="mt-4 border-t border-[var(--color-border)]/40 pt-3">
          <Link
            to={to}
            className="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
          >
            Open
            <ArrowRight className="h-3 w-3" aria-hidden />
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

function AlertsCard({ rows, loading }: { rows: AlertRow[] | undefined; loading: boolean }) {
  const top = (rows ?? []).slice(0, 4);
  const criticals = top.filter((r) => r.severity === 'critical').length;
  const tone: Tone = criticals > 0 ? 'critical' : top.length > 0 ? 'warning' : 'nominal';
  return (
    <SignalCard
      title="Open alerts"
      description="Operator-facing notifications."
      to="/abuse?tab=alerts"
      tone={tone}
      loading={loading}
      empty={!loading && top.length === 0}
      emptyTitle="No alerts."
      badge={
        criticals > 0 ? (
          <Badge variant="destructive">{criticals} critical</Badge>
        ) : top.length > 0 ? (
          <Badge variant="secondary">{top.length}</Badge>
        ) : null
      }
    >
      <ul className="space-y-1.5">
        {top.map((r) => (
          <li key={r.id} className="flex items-center gap-2 text-sm">
            <span
              aria-hidden
              className={cn(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                r.severity === 'critical'
                  ? toneDot.critical
                  : r.severity === 'warn'
                    ? toneDot.warning
                    : toneDot.neutral,
              )}
            />
            <span className="min-w-0 flex-1 truncate" title={r.subject}>
              {r.subject}
            </span>
            <span className="shrink-0 text-xs text-[var(--color-muted-foreground)] tabular-nums">
              {formatRelative(r.created_at)}
            </span>
          </li>
        ))}
      </ul>
    </SignalCard>
  );
}

function DlqCard({ rows, loading }: { rows: DlqRow[] | undefined; loading: boolean }) {
  const top = (rows ?? []).slice(0, 4);
  const tone: Tone =
    top.length === 0 ? 'nominal' : (rows ?? []).length > 10 ? 'critical' : 'warning';
  return (
    <SignalCard
      title="Webhook DLQ"
      description="Dead-lettered deliveries pending replay."
      to="/dlq"
      tone={tone}
      loading={loading}
      empty={!loading && top.length === 0}
      emptyTitle="DLQ is empty."
      badge={
        top.length > 0 ? (
          <Badge variant={tone === 'critical' ? 'destructive' : 'warning'}>
            {(rows ?? []).length}
          </Badge>
        ) : null
      }
    >
      <ul className="space-y-1.5">
        {top.map((r) => (
          <li key={r.id} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">
              {r.webhook_url ?? r.webhook_sub_id}
            </span>
            <span className="shrink-0 text-xs text-[var(--color-muted-foreground)] tabular-nums">
              {r.last_status_code ?? '?'} · {r.attempts}×
            </span>
          </li>
        ))}
      </ul>
    </SignalCard>
  );
}

function AbuseCard({ rows, loading }: { rows: AbuseEventRow[] | undefined; loading: boolean }) {
  const recent = (rows ?? []).filter((r) => ageMs(r.reported_at) < DAY_MS).slice(0, 4);
  const tone: Tone = recent.length > 5 ? 'critical' : recent.length > 0 ? 'warning' : 'nominal';
  return (
    <SignalCard
      title="Abuse signals (24h)"
      description="Newest complaints and bounces."
      to="/abuse?tab=complaints"
      tone={tone}
      loading={loading}
      empty={!loading && recent.length === 0}
      emptyTitle="No new complaints."
      badge={recent.length > 0 ? <Badge variant="warning">{recent.length}</Badge> : null}
    >
      <ul className="space-y-1.5">
        {recent.map((r) => (
          <li key={r.id} className="flex items-center gap-2 text-sm">
            <span className="shrink-0 text-xs text-[var(--color-muted-foreground)]">
              {r.classification.replace(/_/g, ' ')}
            </span>
            <span
              className="min-w-0 flex-1 truncate font-mono text-xs"
              title={r.sender_address ?? ''}
            >
              {r.sender_address ?? '—'}
            </span>
            <span className="shrink-0 text-xs text-[var(--color-muted-foreground)] tabular-nums">
              {formatRelative(r.reported_at)}
            </span>
          </li>
        ))}
      </ul>
    </SignalCard>
  );
}

function BridgesCard({ rows, loading }: { rows: BridgeRow[] | undefined; loading: boolean }) {
  const list = rows ?? [];
  const active = list.filter((b) => !b.disabled_at);
  const stale = active.filter((b) => ageMs(b.last_seen_at) > TEN_MIN_MS);
  const tone: Tone =
    list.length === 0
      ? 'critical'
      : stale.length > 0
        ? 'warning'
        : active.length === 0
          ? 'critical'
          : 'nominal';
  return (
    <SignalCard
      title="Bridges"
      description="On-prem submission and IMAP."
      to="/bridges"
      tone={tone}
      loading={loading}
      empty={!loading && list.length === 0}
      emptyTitle="No bridges registered."
      badge={
        list.length > 0 ? (
          <span className="text-xs text-[var(--color-muted-foreground)] tabular-nums">
            {active.length}/{list.length} up
          </span>
        ) : null
      }
    >
      <ul className="space-y-1.5">
        {list.slice(0, 4).map((b) => {
          const isStale = !b.disabled_at && ageMs(b.last_seen_at) > TWO_MIN_MS;
          const isOff = !!b.disabled_at || ageMs(b.last_seen_at) > TEN_MIN_MS;
          const t: Tone = isOff ? 'critical' : isStale ? 'warning' : 'nominal';
          return (
            <li key={b.id} className="flex items-center gap-2 text-sm">
              <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', toneDot[t])} />
              <span className="min-w-0 flex-1 truncate font-medium">{b.name}</span>
              <span className="shrink-0 text-xs text-[var(--color-muted-foreground)] tabular-nums">
                {formatRelative(b.last_seen_at)}
              </span>
            </li>
          );
        })}
      </ul>
    </SignalCard>
  );
}

function DomainsCard({ rows, loading }: { rows: DomainRow[] | undefined; loading: boolean }) {
  const list = rows ?? [];
  const verified = list.filter((d) => d.status === 'verified').length;
  const pending = list.filter((d) => d.status === 'pending').length;
  const failed = list.filter((d) => d.status === 'failed').length;
  const tone: Tone = failed > 0 ? 'warning' : pending > 0 ? 'soft' : 'nominal';
  const attention = list.filter((d) => d.status !== 'verified').slice(0, 4);
  return (
    <SignalCard
      title="Domains"
      description="Verification ledger."
      to="/domains"
      tone={tone}
      loading={loading}
      empty={!loading && list.length === 0}
      emptyTitle="No domains yet."
    >
      <div className="space-y-3">
        <div className="flex items-baseline gap-4 text-sm tabular-nums">
          <div>
            <div className="text-2xl font-semibold">{verified}</div>
            <div className="text-xs text-[var(--color-muted-foreground)]">verified</div>
          </div>
          <div className="text-[var(--color-muted-foreground)]">
            <div className="text-lg">{pending}</div>
            <div className="text-xs">pending</div>
          </div>
          <div
            className={cn(
              failed > 0 ? 'text-[var(--color-warning)]' : 'text-[var(--color-muted-foreground)]',
            )}
          >
            <div className="text-lg">{failed}</div>
            <div className="text-xs">failed</div>
          </div>
        </div>
        {attention.length > 0 ? (
          <ul className="space-y-1">
            {attention.map((d) => (
              <li key={d.id} className="flex items-center gap-2 text-sm">
                <span
                  aria-hidden
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    d.status === 'failed' ? toneDot.critical : toneDot.warning,
                  )}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{d.name}</span>
                <span className="shrink-0 text-xs text-[var(--color-muted-foreground)]">
                  {d.status}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-[var(--color-muted-foreground)]">All verified.</p>
        )}
      </div>
    </SignalCard>
  );
}

function SyntheticsCard({ rows, loading }: { rows: SyntheticRow[] | undefined; loading: boolean }) {
  const list = rows ?? [];
  const worst =
    list.length === 0
      ? 100
      : Math.min(...list.map((r) => (r.total === 0 ? 100 : (r.passes / r.total) * 100)));
  const tone: Tone = worst >= 99 ? 'nominal' : worst >= 90 ? 'warning' : 'critical';
  return (
    <SignalCard
      title="Synthetic checks"
      description="24-hour pass-rate per probe."
      to="/diagnostics"
      tone={tone}
      loading={loading}
      empty={!loading && list.length === 0}
      emptyTitle="No probes have run."
    >
      <ul className="space-y-1.5">
        {list.slice(0, 5).map((r) => {
          const pct = r.total === 0 ? 0 : Math.round((r.passes / r.total) * 100);
          const t: Tone = pct >= 99 ? 'nominal' : pct >= 90 ? 'warning' : 'critical';
          return (
            <li key={r.check_kind} className="flex items-center gap-2 text-sm">
              <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', toneDot[t])} />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{r.check_kind}</span>
              <span
                className={cn(
                  'shrink-0 text-xs tabular-nums',
                  pct < 90
                    ? 'text-[var(--color-destructive)]'
                    : pct < 99
                      ? 'text-[var(--color-warning)]'
                      : 'text-[var(--color-muted-foreground)]',
                )}
              >
                {pct}%
              </span>
            </li>
          );
        })}
      </ul>
    </SignalCard>
  );
}

// ---------- Quiet footer: cardinality counts ----------

function CardinalityFooter({
  stats,
  loading,
}: {
  stats: StatsOverview | undefined;
  loading: boolean;
}) {
  const items: Array<{ label: string; value: ReactNode; to: string }> = stats
    ? [
        {
          label: 'Mailboxes',
          value: formatNumber(stats.cardinality.mailboxes),
          to: '/mailboxes',
        },
        {
          label: 'Senders',
          value: formatNumber(stats.cardinality.senders),
          to: '/mailboxes',
        },
        {
          label: 'Domains',
          value: formatNumber(
            stats.cardinality.domains_verified +
              stats.cardinality.domains_pending +
              stats.cardinality.domains_failed,
          ),
          to: '/domains',
        },
        {
          label: 'API keys',
          value: formatNumber(stats.cardinality.credentials_api_key),
          to: '/me',
        },
        {
          label: 'SMTP creds',
          value: formatNumber(stats.cardinality.credentials_smtp),
          to: '/me',
        },
        {
          label: 'Webhook subs',
          value: formatNumber(stats.cardinality.webhook_subs),
          to: '/me',
        },
      ]
    : [];

  return (
    <div className="rounded-xl bg-[var(--color-card)] ring-1 ring-[var(--color-border)]/40">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold">Resources</h3>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Inventory across the tenant.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-0 border-t border-[var(--color-border)]/40 sm:grid-cols-3 lg:grid-cols-6">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="border-r border-[var(--color-border)]/40 p-5 last:border-r-0">
                <Skeleton className="h-7 w-12" />
                <Skeleton className="mt-1 h-3 w-20" />
              </div>
            ))
          : items.map((it, idx) => (
              <Link
                key={it.label}
                to={it.to}
                className={cn(
                  'block p-5 transition-colors hover:bg-[var(--color-accent)]',
                  idx < items.length - 1
                    ? 'border-b border-[var(--color-border)]/40 lg:border-b-0 lg:border-r'
                    : '',
                  idx % 2 === 0 ? 'border-r sm:border-r' : 'sm:border-r lg:border-r',
                )}
              >
                <div className="text-2xl font-semibold tabular-nums">{it.value}</div>
                <div className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                  {it.label}
                </div>
              </Link>
            ))}
      </div>
    </div>
  );
}

// ---------- Quick actions strip ----------

function QuickActions() {
  const items = [
    { label: 'Mailboxes', to: '/mailboxes', icon: Inbox },
    { label: 'Messages', to: '/messages', icon: Send },
    { label: 'Domains', to: '/domains', icon: Globe2 },
    { label: 'Diagnostics', to: '/diagnostics', icon: Stethoscope },
  ] as const;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <Button key={it.to} asChild variant="outline" size="sm">
            <Link to={it.to}>
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {it.label}
            </Link>
          </Button>
        );
      })}
    </div>
  );
}

// ---------- Page ----------

export function Dashboard() {
  const [window, setWindow] = useState<WindowKey>('24h');
  const compWindow = comparisonWindow(window);

  // Headline queries — 30s staleTime so the hero doesn't flicker as other
  // panels refetch.
  const current = useAdminQuery<StatsOverview>(
    statsKeys.overview(window),
    `/api/admin/stats/overview?window=${window}`,
    { staleTime: 30_000 },
  );
  const comparison = useAdminQuery<StatsOverview>(
    statsKeys.overview(compWindow),
    `/api/admin/stats/overview?window=${compWindow}`,
    { staleTime: 30_000, enabled: compWindow !== window },
  );
  const bridges = useAdminQuery<{ data: BridgeRow[] }>(bridgeKeys.list(), '/api/admin/bridges', {
    staleTime: 30_000,
  });
  const synthetics = useAdminQuery<{ data: SyntheticRow[] }>(
    syntheticKeys.summary(),
    '/api/admin/synthetic-runs/summary',
    { staleTime: 30_000 },
  );
  const chain = useAdminQuery<ChainStatus>(auditKeys.chainStatus(), '/api/audit/chain-status', {
    staleTime: 30_000,
  });

  // Signal queries — power both the column cards and the activity feed.
  const alerts = useAdminQuery<{ data: AlertRow[] }>(adminAlertKeys.list(), '/api/admin/alerts');
  const abuse = useAdminQuery<{ data: AbuseEventRow[] }>(
    abuseEventKeys.list(),
    '/api/admin/abuse-events',
  );
  const dlq = useAdminQuery<{ data: DlqRow[] }>(dlqKeys.list(), '/api/admin/webhook-dlq');
  const domains = useAdminQuery<{ data: DomainRow[] }>(domainKeys.list(), '/api/admin/domains');
  const senders = useAdminQuery<{ data: SenderProfileRow[] }>(
    senderAbuseKeys.list(),
    '/api/admin/sender-abuse-profiles',
  );

  const bridgeRows = bridges.data?.data;
  const syntheticRows = synthetics.data?.data;
  const alertRows = alerts.data?.data;
  const abuseRows = abuse.data?.data;
  const dlqRows = dlq.data?.data;
  const domainRows = domains.data?.data;
  const senderRows = senders.data?.data;

  const action = useMemo(
    () =>
      chooseNextAction({
        stats: current.data,
        bridges: bridgeRows,
        synthetics: syntheticRows,
        chain: chain.data,
        alerts: alertRows,
        domains: domainRows,
        senders: senderRows,
        dlq: dlqRows,
      }),
    [
      current.data,
      bridgeRows,
      syntheticRows,
      chain.data,
      alertRows,
      domainRows,
      senderRows,
      dlqRows,
    ],
  );

  const activity = useMemo(
    () =>
      buildActivityFeed({
        alerts: alertRows,
        abuse: abuseRows,
        dlq: dlqRows,
        bridges: bridgeRows,
        domains: domainRows,
      }),
    [alertRows, abuseRows, dlqRows, bridgeRows, domainRows],
  );

  const healthPills: HealthPillSpec[] = [
    pipelineHealth(current.data),
    bridgesHealth(bridgeRows),
    syntheticsHealth(syntheticRows),
    auditHealth(chain.data),
  ];

  return (
    <PageCard
      decorative
      title="Overview"
      description="Operational headline, current signals, recent activity."
      actions={<QuickActions />}
    >
      <div className="space-y-6">
        {/* Headline KPI + slim NextAction banner. */}
        <section aria-label="Headline" className="space-y-3">
          <HeadlineKPI
            window={window}
            onWindowChange={setWindow}
            current={current.data}
            comparison={comparison.data}
            loading={current.isLoading}
          />
          <NextActionBanner action={action} />
        </section>

        {/* Compact health strip. */}
        <section
          aria-label="Health"
          className="-mx-1 flex flex-wrap items-center gap-2 overflow-x-auto px-1"
        >
          <HealthPill spec={healthPills[0]!} loading={current.isLoading} />
          <HealthPill spec={healthPills[1]!} loading={bridges.isLoading} />
          <HealthPill spec={healthPills[2]!} loading={synthetics.isLoading} />
          <HealthPill spec={healthPills[3]!} loading={chain.isLoading} />
        </section>

        {/* Signal cards (2-col) + activity feed (1-col) on xl. Stacks below. */}
        <section
          aria-label="Signals and activity"
          className="grid grid-cols-1 gap-4 xl:grid-cols-3"
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:col-span-2">
            <AlertsCard rows={alertRows} loading={alerts.isLoading} />
            <DlqCard rows={dlqRows} loading={dlq.isLoading} />
            <AbuseCard rows={abuseRows} loading={abuse.isLoading} />
            <BridgesCard rows={bridgeRows} loading={bridges.isLoading} />
            <DomainsCard rows={domainRows} loading={domains.isLoading} />
            <SyntheticsCard rows={syntheticRows} loading={synthetics.isLoading} />
          </div>
          <div className="xl:col-span-1">
            <ActivityFeed
              items={activity}
              loading={
                alerts.isLoading &&
                abuse.isLoading &&
                dlq.isLoading &&
                bridges.isLoading &&
                domains.isLoading
              }
            />
          </div>
        </section>

        {/* Cardinality footer. */}
        <section aria-label="Resources">
          <CardinalityFooter stats={current.data} loading={current.isLoading} />
        </section>
      </div>
    </PageCard>
  );
}
