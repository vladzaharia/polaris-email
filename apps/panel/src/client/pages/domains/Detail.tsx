// Domain detail — redesigned 2026-05.
//
// What was wrong with the previous incarnation: every concern lived on the
// same scroll surface. Header buttons → status badge → CF zone → DMARC
// promotion → DNS checklist → MTA-STS + TLS-RPT → DMARC alignment summary,
// stacked top-to-bottom. ~600 lines. To answer "is DMARC at reject?" the
// operator had to scroll past a 30-row routing-DNS table. The DNS checklist
// was gated behind a Verify click, which made the first-run experience
// confusing: an operator who just typed the URL saw a tip ("Run Verify DNS")
// where they expected the most-important content on the page.
//
// What this rewrite is optimising for:
//   1. Time-to-answer for the four common operator tasks — onboarding,
//      SRE bounce triage, compliance DMARC review, T&S sender abuse triage.
//   2. A persistent health hero (4 status pills) above the tab strip, so
//      the at-a-glance state is visible from any tab without scrolling.
//   3. Tabs (Overview / DNS & TLS / DMARC / Activity), URL-persisted via
//      `?tab=`, so deep links survive reloads and runbooks pin specific
//      tabs the way the Abuse Hub already does.
//   4. The Verify checklist auto-runs once when the DNS & TLS tab opens
//      and exposes a Re-run button — no more first-paint dead state.
//   5. Risk highlights surface inline (pending > 24h is red, MTA-STS stuck
//      in testing > 7d is amber, DMARC=`none` is amber) so the operator's
//      eye lands on the actual problem instead of a uniformly-neutral list.
//   6. Every destructive action (delete, disable inbound, rotate DKIM,
//      promote MTA-STS, disable MTA-STS/TLS-RPT) keeps its existing
//      DestructiveActionDialog with the original blast-radius copy.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  Activity,
  AlertTriangle,
  Cloud,
  Flag,
  Globe2,
  Key,
  Lock,
  MailCheck,
  MailX,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { PageCard } from '../../layouts/PageCard.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { DestructiveActionDialog } from '../../components/DestructiveActionDialog.js';
import { ErrorText } from '../../components/ErrorText.js';
import { EmptyState } from '../../components/EmptyState.js';
import { MetaList, MetaRow } from '../../components/MetaList.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { formatDate, formatRelative } from '../../lib/format.js';
import {
  cfZoneKeys,
  dmarcKeys,
  dmarcPromotionKeys,
  domainKeys,
  tlsRptKeys,
} from '../../queryKeys.js';
import { ApiError } from '../../lib/api.js';
import { cn } from '../../lib/cn.js';

// ---------- domain query shape ----------

interface DomainPayload {
  id: string;
  name: string;
  status: string;
  dkim_selector: string | null;
  inbound_enabled?: number;
  outbound_enabled?: number;
  dmarc_policy?: string | null;
  dmarc_rua?: string | null;
  verified_at?: string | null;
  last_verify_check_at?: string | null;
  created_at?: string;
  updated_at?: string;
  disabled_at?: string | null;
  // MTA-STS + TLS-RPT
  mta_sts_mode?: 'none' | 'testing' | 'enforce';
  mta_sts_policy_id?: string | null;
  mta_sts_max_age?: number;
  mta_sts_verified_at?: string | null;
  tlsrpt_enabled?: number;
  tlsrpt_rua?: string | null;
  tlsrpt_verified_at?: string | null;
}

interface VerifyCheck {
  name: string;
  ok: boolean;
  expected: string;
  actual: string;
  /**
   * Whether failure is a hard-fail (default — MX / routing DNS) or a
   * soft warning (MTA-STS / TLS-RPT — opt-in hardening). The UI uses
   * this to colour failed rows amber instead of red.
   */
  required?: boolean;
}

interface VerifyResponse {
  id: string;
  status: string;
  checks: VerifyCheck[];
  message?: string;
}

interface CfZoneStatus {
  zone: { id: string; name: string };
  /**
   * When the inspector's CF API calls fail (most commonly: the
   * CF_API_TOKEN lacks Email Routing / DNS scopes), this carries the
   * last-error message. UI uses it to give the operator an actionable
   * "your token can't see this" hint instead of just "everything = no".
   */
  error: string | null;
  routing_enabled: boolean;
  routing_status: string;
  routing_status_ok: boolean;
  dns_records_locked: boolean;
  dns_record_errors: string[];
  sender_onboarded: boolean;
  sender_missing_records: string[];
  catch_all_correct: boolean;
  catch_all_target: string | null;
  has_conflicting_rules: boolean;
  /**
   * Named-address routing rules CF reports for this zone (catch-all
   * excluded). The panel surfaces them as "externally managed" — they
   * route specific addresses operator-side (forwarding personal mail,
   * for example) and override the catch-all by design. `routes_to_polaris`
   * flips true when the action targets `polaris-mail-in`, in which case
   * the rule is part of Polaris's intended config rather than external.
   */
  named_rules: {
    name: string;
    address_pattern: string | null;
    action_type: string | null;
    action_target: string | null;
    enabled: boolean;
    routes_to_polaris: boolean;
  }[];
  d1_mail_domain_exists: boolean;
  overall: 'ok' | 'partial' | 'unconfigured' | 'error';
}

interface DmarcPromotionRow {
  id: string;
  name: string;
  dmarc_policy: string | null;
  dmarc_promotion_mode: 'auto' | 'manual' | 'paused';
  dmarc_promotion_state:
    | 'none'
    | 'quarantine_ready'
    | 'quarantine'
    | 'reject_ready'
    | 'reject'
    | 'paused';
  dmarc_promotion_last_at: string | null;
  dmarc_record_managed_by_polaris: number;
}

interface DmarcSummaryWindow {
  reports: number;
  total: number;
  dmarc_pass_pct: number;
  dkim_pass_pct: number;
  spf_pass_pct: number;
  last_seen_at: string | null;
}

interface DmarcSummaryPayload {
  domain: string;
  today: string;
  last_7d: DmarcSummaryWindow;
  last_14d: DmarcSummaryWindow;
  last_30d: DmarcSummaryWindow;
}

interface TlsReportSummaryPayload {
  domain: string;
  last_7d: { reports: number; success: number; failure: number; latest_at: string | null };
  last_30d: { reports: number; success: number; failure: number; latest_at: string | null };
  top_failures_7d: Array<{ result_type: string; failed: number }>;
}

interface SenderRow {
  id: string;
  mailbox_id: string;
  domain_id: string;
  address: string;
  local_part: string;
  default_for_mailbox: number;
  created_at: string;
  disabled_at: string | null;
}

// ---------- search params ----------

type DomainTab = 'overview' | 'dns' | 'dmarc' | 'activity';

interface DomainDetailSearch {
  tab?: DomainTab;
}

const TAB_DESCRIPTIONS: Record<DomainTab, string> = {
  overview: 'At-a-glance health, key metadata, and recent transitions.',
  dns: 'DNS verification, Cloudflare routing, and inbound TLS hardening.',
  dmarc: 'Promotion state, alignment, and TLS-RPT aggregate reports.',
  activity: 'Senders bound to this domain and recent activity timestamps.',
};

// ---------- small derived helpers ----------

/**
 * Risk classifier for the four header pills. Returns the visual variant the
 * pill should render in. Centralised here so the design intent ("amber means
 * stuck more than 7 days") lives next to the badge, not buried in JSX.
 */
function pillVariant(args: {
  kind: 'dns' | 'dkim' | 'dmarc' | 'mtasts';
  d: DomainPayload;
  promotion?: DmarcPromotionRow;
}): 'success' | 'warning' | 'destructive' | 'secondary' | 'outline' {
  const { kind, d, promotion } = args;
  if (kind === 'dns') {
    if (d.status === 'verified') return 'success';
    if (d.status === 'failed' || d.status === 'disabled') return 'destructive';
    if (d.status === 'pending') {
      // Pending > 24h is a real warning sign — the operator forgot to push
      // DNS or routing isn't picking up the records.
      const created = d.created_at ? new Date(d.created_at).getTime() : Date.now();
      const ageH = (Date.now() - created) / 36e5;
      return ageH > 24 ? 'destructive' : 'secondary';
    }
    return 'outline';
  }
  if (kind === 'dkim') {
    return d.dkim_selector ? 'success' : 'destructive';
  }
  if (kind === 'dmarc') {
    const policy = promotion?.dmarc_policy ?? d.dmarc_policy ?? null;
    if (policy === 'reject') return 'success';
    if (policy === 'quarantine') return 'secondary';
    if (policy === 'none' || policy == null) return 'warning';
    return 'outline';
  }
  if (kind === 'mtasts') {
    if (d.mta_sts_mode === 'enforce') return 'success';
    if (d.mta_sts_mode === 'testing') {
      // Stuck in `testing` > 7d is a yellow signal — operator started the
      // ramp-up but forgot to promote.
      const verified = d.mta_sts_verified_at
        ? new Date(d.mta_sts_verified_at).getTime()
        : Date.now();
      const ageD = (Date.now() - verified) / 86400000;
      return ageD > 7 ? 'warning' : 'secondary';
    }
    return 'outline';
  }
  return 'outline';
}

function pctVariant(pct: number): 'success' | 'secondary' | 'destructive' {
  if (pct >= 99) return 'success';
  if (pct >= 90) return 'secondary';
  return 'destructive';
}

// ---------- HealthHero: 4 status pills above the tab strip ----------

function HealthHero({ d, promotion }: { d: DomainPayload; promotion?: DmarcPromotionRow }) {
  const dnsVariant = pillVariant({ kind: 'dns', d });
  const dkimVariant = pillVariant({ kind: 'dkim', d });
  const dmarcVariant = pillVariant({ kind: 'dmarc', d, promotion });
  const mtaVariant = pillVariant({ kind: 'mtasts', d });
  const dmarcPolicy = promotion?.dmarc_policy ?? d.dmarc_policy ?? 'none';
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <HeroPill
        icon={<Globe2 className="h-4 w-4" aria-hidden />}
        label="DNS"
        variant={dnsVariant}
        value={d.status}
        sub={d.verified_at ? `verified ${formatRelative(d.verified_at)}` : 'never verified'}
      />
      <HeroPill
        icon={<Key className="h-4 w-4" aria-hidden />}
        label="DKIM"
        variant={dkimVariant}
        value={d.dkim_selector ?? 'none'}
        sub={d.dkim_selector ? 'selector set' : 'no selector — rotate'}
      />
      <HeroPill
        icon={<ShieldCheck className="h-4 w-4" aria-hidden />}
        label="DMARC"
        variant={dmarcVariant}
        value={`p=${dmarcPolicy}`}
        sub={promotion?.dmarc_promotion_state ?? 'no promotion state'}
      />
      <HeroPill
        icon={<Lock className="h-4 w-4" aria-hidden />}
        label="MTA-STS"
        variant={mtaVariant}
        value={d.mta_sts_mode ?? 'none'}
        sub={d.tlsrpt_enabled === 1 ? 'TLS-RPT on' : 'TLS-RPT off'}
      />
    </div>
  );
}

function HeroPill({
  icon,
  label,
  variant,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  variant: 'success' | 'warning' | 'destructive' | 'secondary' | 'outline';
  value: string;
  sub: string;
}) {
  // Tint background using the variant's semantic colour so the eye groups
  // the four pills by status. `color-mix` keeps the surface soft enough to
  // sit under the foreground text.
  const tintMap: Record<typeof variant, string> = {
    success:
      'border-[color-mix(in_oklch,var(--color-success)_30%,var(--color-border))] bg-[color-mix(in_oklch,var(--color-success)_10%,transparent)]',
    warning:
      'border-[color-mix(in_oklch,var(--color-warning)_30%,var(--color-border))] bg-[color-mix(in_oklch,var(--color-warning)_10%,transparent)]',
    destructive:
      'border-[color-mix(in_oklch,var(--color-destructive)_30%,var(--color-border))] bg-[color-mix(in_oklch,var(--color-destructive)_10%,transparent)]',
    secondary: 'border-[var(--color-border)] bg-[var(--color-secondary)]',
    outline: 'border-[var(--color-border)] bg-[var(--color-card)]',
  };
  return (
    <div className={cn('rounded-md border px-3 py-2', tintMap[variant])}>
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Badge variant={variant}>{value}</Badge>
      </div>
      <div className="mt-1 text-xs text-[var(--color-muted-foreground)]">{sub}</div>
    </div>
  );
}

// ---------- RiskBanner: surfaces the worst single signal as a single line ----------

interface RiskMessage {
  level: 'warning' | 'destructive';
  text: string;
}

function risksFor(d: DomainPayload, promotion?: DmarcPromotionRow): RiskMessage[] {
  const out: RiskMessage[] = [];
  if (d.status === 'pending') {
    const created = d.created_at ? new Date(d.created_at).getTime() : Date.now();
    const ageH = (Date.now() - created) / 36e5;
    if (ageH > 24) {
      out.push({
        level: 'destructive',
        text: `Domain has been pending for ${Math.floor(ageH)}h — DNS push may have stalled.`,
      });
    }
  }
  if (d.status === 'failed') {
    out.push({
      level: 'destructive',
      text: 'Last verification failed. Open DNS & TLS to see which records are missing.',
    });
  }
  const policy = promotion?.dmarc_policy ?? d.dmarc_policy ?? null;
  if (!policy || policy === 'none') {
    out.push({
      level: 'warning',
      text: 'DMARC policy is p=none. Open the DMARC tab to promote to quarantine/reject.',
    });
  }
  if (d.mta_sts_mode === 'testing' && d.mta_sts_verified_at) {
    const ageD = (Date.now() - new Date(d.mta_sts_verified_at).getTime()) / 86400000;
    if (ageD > 7) {
      out.push({
        level: 'warning',
        text: `MTA-STS has been in testing mode for ${Math.floor(ageD)} days — consider promoting to enforce.`,
      });
    }
  }
  if (d.inbound_enabled === 0) {
    out.push({
      level: 'warning',
      text: 'Inbound is disabled — all receivers on this domain are blackholed.',
    });
  }
  return out;
}

function RiskBanner({ risks }: { risks: RiskMessage[] }) {
  if (risks.length === 0) return null;
  return (
    <div className="space-y-2">
      {risks.map((r) => (
        <div
          key={r.text}
          role={r.level === 'destructive' ? 'alert' : 'status'}
          className={cn(
            'flex items-start gap-2 rounded-md border p-3 text-sm',
            r.level === 'destructive'
              ? 'border-[var(--color-destructive)] bg-[color-mix(in_oklch,var(--color-destructive)_10%,transparent)] text-[var(--color-destructive)]'
              : 'border-[color-mix(in_oklch,var(--color-warning)_40%,var(--color-border))] bg-[color-mix(in_oklch,var(--color-warning)_10%,transparent)]',
          )}
        >
          {r.level === 'destructive' ? (
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          )}
          <span>{r.text}</span>
        </div>
      ))}
    </div>
  );
}

// ---------- Section helpers ----------

function SectionTitle({
  icon,
  title,
  trailing,
}: {
  icon: React.ReactNode;
  title: string;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <span className="text-[var(--color-muted-foreground)]" aria-hidden>
          {icon}
        </span>
        {title}
      </h2>
      {trailing}
    </div>
  );
}

// ---------- CF zone subsection (DNS & TLS tab) ----------

// Op-kinds the inspector can fix via POST /v1/admin/cf-zones/:name/configure.
// `dns_locked` is intentionally NOT here — "locking" existing operator-managed
// records would require deleting and re-creating them via CF's Email Routing
// wizard. Risky, irreversible, and the records themselves resolve correctly
// without it; flagging this as cosmetic in the UI.
type ConfigureOpKind =
  | 'enable_routing'
  | 'set_catch_all_worker'
  | 'onboard_sender_domain'
  | 'create_d1_mail_domain';

interface FixSpec {
  kind: ConfigureOpKind;
  title: string;
  /** Short label for the inline button (verb phrase, no period). */
  cta: string;
  /** Blast-radius bullets shown in the confirm dialog. */
  blast: string[];
  reversible: boolean;
}

const FIX_SPECS: Record<ConfigureOpKind, FixSpec> = {
  enable_routing: {
    kind: 'enable_routing',
    title: 'Enable Cloudflare Email Routing',
    cta: 'Enable routing',
    blast: [
      'Cloudflare auto-publishes inbound MX + SPF records and locks them.',
      'Routing becomes active immediately; mail flow starts the moment DNS propagates.',
      'Reversible by toggling Email Routing off in the CF dashboard.',
    ],
    reversible: true,
  },
  set_catch_all_worker: {
    kind: 'set_catch_all_worker',
    title: 'Route catch-all to polaris-mail-in',
    cta: 'Fix catch-all',
    blast: [
      'Mail to addresses not matched by any named rule will deliver into Polaris.',
      'Any current catch-all action (drop / forward / unset) is replaced.',
      'Named-address rules above the catch-all are unaffected — they still intercept their own addresses.',
    ],
    reversible: true,
  },
  onboard_sender_domain: {
    kind: 'onboard_sender_domain',
    title: 'Onboard sender domain',
    cta: 'Onboard sender',
    blast: [
      'Adds missing DKIM CNAMEs, SPF, DMARC, and the cf-bounce MX to the zone.',
      'Existing records with conflicting content are left untouched (no clobber).',
      'New records resolve once CF DNS propagates (usually within a minute).',
    ],
    reversible: true,
  },
  create_d1_mail_domain: {
    kind: 'create_d1_mail_domain',
    title: 'Create the D1 mail_domains row',
    cta: 'Create D1 row',
    blast: [
      "Adds a `mail_domains` row in Polaris's D1 for this zone.",
      'No DNS effect; this only registers the zone inside Polaris.',
      'Reversible via Domain Detail → Delete domain.',
    ],
    reversible: true,
  },
};

interface ConfigureResponse {
  applied?: { kind: ConfigureOpKind }[];
  failed?: { op: { kind: ConfigureOpKind }; error: string }[];
}

function CfZoneCard({ domainName }: { domainName: string }) {
  const q = useAdminQuery<{ data: CfZoneStatus }>(
    cfZoneKeys.detail(domainName),
    `/api/admin/cf-zones/${encodeURIComponent(domainName)}`,
    { staleTime: 60_000 },
  );
  const cfCredsMissing = q.error instanceof ApiError && q.error.code === 'cf_credentials_missing';
  const configure = useAdminMutation<ConfigureResponse, { kinds: ConfigureOpKind[] }>(
    ({ kinds }) => ({
      path: `/api/admin/cf-zones/${encodeURIComponent(domainName)}/configure`,
      method: 'POST',
      body: { dry_run: false, op_kinds: kinds },
    }),
    {
      invalidateKeys: [cfZoneKeys.detail(domainName), cfZoneKeys.list()],
      successMessage: 'Zone configured.',
    },
  );
  const [pendingFix, setPendingFix] = useState<FixSpec | null>(null);
  return (
    <section className="rounded-md border border-[var(--color-border)] p-4">
      <SectionTitle icon={<Cloud className="h-4 w-4" />} title="Cloudflare zone" />
      {q.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : cfCredsMissing ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">
          CF zone status unavailable: set <code>CF_API_TOKEN</code> + <code>CF_ACCOUNT_ID</code> via{' '}
          <code>polaris-mail setup infra secrets seed</code>.
        </p>
      ) : q.error ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">
          No matching Cloudflare zone for <span className="font-mono">{domainName}</span>.
        </p>
      ) : !q.data ? null : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={
                q.data.data.overall === 'ok'
                  ? 'success'
                  : q.data.data.overall === 'partial'
                    ? 'warning'
                    : q.data.data.overall === 'unconfigured'
                      ? 'secondary'
                      : 'destructive'
              }
            >
              {q.data.data.overall}
            </Badge>
            <span className="font-mono text-xs text-[var(--color-muted-foreground)]">
              {q.data.data.zone.name}
            </span>
          </div>
          {/* When the inspector's CF API calls fail, every per-record
              row collapses to a misleading "no" / "unset". Show the
              concrete error so the operator knows what to fix —
              typically the CF_API_TOKEN missing Email Routing scope. */}
          {q.data.data.error ? (
            <div className="rounded-md border border-[var(--color-destructive)]/40 bg-[color-mix(in_oklch,var(--color-destructive)_8%,transparent)] p-3 text-xs">
              <div className="mb-1 font-medium text-[var(--color-destructive)]">
                Cloudflare API error
              </div>
              <div className="font-mono break-all text-[var(--color-foreground)]">
                {q.data.data.error}
              </div>
              <div className="mt-2 text-[var(--color-muted-foreground)]">
                The per-record results below are unreliable while this error persists. The most
                common cause is a CF_API_TOKEN missing{' '}
                <code className="font-mono">Zone:Email Routing</code>,{' '}
                <code className="font-mono">Account:Email Routing Addresses</code>, or{' '}
                <code className="font-mono">Account:Email Service</code> scope. Re-mint the token
                with those scopes and update the secret via{' '}
                <code className="font-mono">polaris-mail setup infra secrets seed</code>.
              </div>
            </div>
          ) : null}
          <MetaList>
            <MetaRow label="Email Routing">
              <FixableRowValue
                badge={
                  <Badge
                    variant={
                      q.data.data.routing_enabled
                        ? q.data.data.routing_status_ok
                          ? 'success'
                          : 'warning'
                        : 'destructive'
                    }
                  >
                    {q.data.data.routing_status}
                  </Badge>
                }
                fix={!q.data.data.routing_enabled ? FIX_SPECS.enable_routing : null}
                onFix={setPendingFix}
                pending={configure.isPending}
              />
            </MetaRow>
            <MetaRow label="DNS locked">
              {/* Not actionable from here: "locking" existing operator
                  records requires delete-and-recreate via CF's wizard.
                  Showing as informational (secondary) rather than red. */}
              <Badge variant={q.data.data.dns_records_locked ? 'success' : 'secondary'}>
                {q.data.data.dns_records_locked ? 'yes' : 'operator-managed'}
              </Badge>
            </MetaRow>
            <MetaRow label="Sender onboarded">
              <FixableRowValue
                badge={
                  <Badge variant={q.data.data.sender_onboarded ? 'success' : 'warning'}>
                    {q.data.data.sender_onboarded ? 'yes' : 'partial'}
                  </Badge>
                }
                fix={!q.data.data.sender_onboarded ? FIX_SPECS.onboard_sender_domain : null}
                onFix={setPendingFix}
                pending={configure.isPending}
              />
            </MetaRow>
            <MetaRow label="Catch-all">
              <FixableRowValue
                badge={
                  <Badge variant={q.data.data.catch_all_correct ? 'success' : 'destructive'}>
                    {q.data.data.catch_all_target ?? 'unset'}
                  </Badge>
                }
                fix={!q.data.data.catch_all_correct ? FIX_SPECS.set_catch_all_worker : null}
                onFix={setPendingFix}
                pending={configure.isPending}
              />
            </MetaRow>
            <MetaRow label="D1 mailbox row">
              {!q.data.data.d1_mail_domain_exists ? (
                <FixableRowValue
                  badge={<Badge variant="destructive">missing</Badge>}
                  fix={FIX_SPECS.create_d1_mail_domain}
                  onFix={setPendingFix}
                  pending={configure.isPending}
                />
              ) : (
                <Badge variant="success">present</Badge>
              )}
            </MetaRow>
          </MetaList>

          {/* Externally managed CF Email Routing rules. These are
              operator-defined catches that intercept specific addresses
              before the catch-all (e.g. forwarding `vlad@plrs.im` to a
              personal mailbox). They take priority over polaris-mail-in
              by design; we surface them so the operator can see what's
              covered without having to bounce to the CF dashboard. */}
          {q.data.data.named_rules.length > 0 ? (
            <div className="rounded-md border border-[var(--color-border)] p-3">
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="font-medium text-[var(--color-foreground)]">
                  Externally managed routes
                </span>
                <span className="text-[var(--color-muted-foreground)]">
                  {q.data.data.named_rules.length} CF rule
                  {q.data.data.named_rules.length === 1 ? '' : 's'} — managed in Cloudflare, shown
                  here for reference
                </span>
              </div>
              <ul className="space-y-1">
                {q.data.data.named_rules.map((rule) => {
                  const action =
                    rule.action_type && rule.action_target
                      ? `${rule.action_type}:${rule.action_target}`
                      : (rule.action_type ?? '?');
                  return (
                    <li key={rule.name} className="flex flex-wrap items-center gap-2 text-xs">
                      <Badge variant={rule.enabled ? 'secondary' : 'outline'}>
                        {rule.enabled ? 'active' : 'disabled'}
                      </Badge>
                      {rule.routes_to_polaris ? (
                        <Badge variant="success">polaris</Badge>
                      ) : (
                        <Badge variant="outline">external</Badge>
                      )}
                      <span className="font-mono">{rule.address_pattern ?? '(no pattern)'}</span>
                      <span className="text-[var(--color-muted-foreground)]">→</span>
                      <span className="font-mono">{action}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {/* Confirmation dialog: the operator clicks "Fix X" inline next
              to a broken row, which opens this with the op-specific
              blast-radius bullets. On confirm we POST the configure
              endpoint with the single op_kind and invalidate the zone
              query so the row turns green. */}
          <DestructiveActionDialog
            open={pendingFix != null}
            onOpenChange={(o) => !o && setPendingFix(null)}
            action={pendingFix?.title ?? ''}
            blastRadius={pendingFix?.blast ?? []}
            reversible={pendingFix?.reversible ?? true}
            confirmLabel={pendingFix?.cta ?? 'Apply'}
            isPending={configure.isPending}
            onConfirm={async () => {
              if (!pendingFix) return;
              await configure.mutateAsync({ kinds: [pendingFix.kind] });
              setPendingFix(null);
            }}
          />
        </div>
      )}
    </section>
  );
}

/**
 * Inline value renderer for CF zone status rows: the badge sits on the
 * left, an optional "Fix X" button on the right when the row is in a
 * non-green state and CF supports a one-call remediation. Clicking the
 * button bubbles the FixSpec up to the parent, which opens a single
 * shared DestructiveActionDialog (so the dialog state isn't duplicated
 * across rows).
 */
function FixableRowValue({
  badge,
  fix,
  onFix,
  pending,
}: {
  badge: React.ReactNode;
  fix: FixSpec | null;
  onFix: (spec: FixSpec) => void;
  pending: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {badge}
      {fix ? (
        <Button size="sm" variant="outline" onClick={() => onFix(fix)} disabled={pending}>
          {fix.cta}
        </Button>
      ) : null}
    </div>
  );
}

// ---------- DNS checklist (DNS & TLS tab) ----------

function DnsChecklist({
  id,
  domainName,
  onEnableMtaSts,
  onEnableTlsRpt,
  enableMtaStsPending,
  enableTlsRptPending,
}: {
  id: string;
  domainName: string;
  onEnableMtaSts: () => Promise<void>;
  onEnableTlsRpt: () => Promise<void>;
  enableMtaStsPending: boolean;
  enableTlsRptPending: boolean;
}) {
  const [result, setResult] = useState<VerifyResponse | null>(null);
  const verify = useAdminMutation<VerifyResponse, undefined>(
    () => ({ path: `/api/admin/domains/${id}/verify`, method: 'POST' }),
    { invalidateKeys: [domainKeys.detail(id)], silent: true },
  );

  // Auto-run on first mount of this tab so the operator never sees an empty
  // "click Verify" splash on a freshly-loaded page. The mutation is silent;
  // if it fails it just leaves the result empty and we'll show the same tip
  // the old layout used to show — but with a one-click Re-run button.
  useEffect(() => {
    let cancelled = false;
    void verify
      .mutateAsync(undefined)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch(() => {
        // Swallow — the empty state below handles the no-checks case.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function rerun() {
    const r = await verify.mutateAsync(undefined);
    setResult(r);
  }

  const okCount = result?.checks.filter((c) => c.ok).length ?? 0;
  const totalCount = result?.checks.length ?? 0;

  return (
    <section className="rounded-md border border-[var(--color-border)] p-4">
      <SectionTitle
        icon={<Globe2 className="h-4 w-4" />}
        title="DNS checklist"
        trailing={
          <div className="flex items-center gap-3">
            {result ? (
              <span className="text-xs text-[var(--color-muted-foreground)]">
                {okCount}/{totalCount} passing
              </span>
            ) : null}
            <Button size="sm" variant="outline" onClick={rerun} disabled={verify.isPending}>
              <RefreshCw className={cn('h-3.5 w-3.5', verify.isPending && 'animate-spin')} />
              {verify.isPending ? 'Re-running…' : 'Re-run'}
            </Button>
          </div>
        }
      />
      {verify.isPending && !result ? (
        <Skeleton className="h-24 w-full" />
      ) : !result ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Verification unavailable for <span className="font-mono">{domainName}</span>. Confirm CF
          API credentials and a cached zone id, then press Re-run.
        </p>
      ) : result.checks.length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {result.message ?? 'Verification returned no checks.'}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Check</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Expected</TableHead>
              <TableHead>Actual</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.checks.map((ch) => {
              const isMtaStsAction = ch.name.startsWith('mta-sts:operator-action:');
              const isTlsRptAction = ch.name.startsWith('tls-rpt:operator-action:');
              const isOperatorAction = isMtaStsAction || isTlsRptAction;
              const inlineFix = isMtaStsAction
                ? {
                    label: 'Re-publish MTA-STS',
                    run: async () => {
                      await onEnableMtaSts();
                      await rerun();
                    },
                    pending: enableMtaStsPending,
                  }
                : isTlsRptAction
                  ? {
                      label: 'Re-publish TLS-RPT',
                      run: async () => {
                        await onEnableTlsRpt();
                        await rerun();
                      },
                      pending: enableTlsRptPending,
                    }
                  : null;
              // Required (default) vs optional split: MX / CNAMEs are
              // hard requirements and render destructive on fail.
              // MTA-STS / TLS-RPT / their operator-action prompts are
              // opt-in hardening and render as warnings — the operator
              // hasn't enabled the extra layer yet or it's still
              // propagating. Soft fails still tint the row amber so the
              // operator can spot them, just not as alarmingly as a
              // routing-broken red row.
              const isOptional = ch.required === false || isOperatorAction;
              return (
                <TableRow
                  key={ch.name}
                  className={
                    !ch.ok && isOptional
                      ? 'bg-[color-mix(in_oklch,var(--color-warning)_15%,transparent)]'
                      : !ch.ok
                        ? 'bg-[color-mix(in_oklch,var(--color-destructive)_8%,transparent)]'
                        : undefined
                  }
                >
                  <TableCell className="break-all font-mono text-xs">{ch.name}</TableCell>
                  <TableCell>
                    {ch.ok ? (
                      <Badge variant="success">ok</Badge>
                    ) : isOptional ? (
                      <Badge variant="warning">
                        {isOperatorAction ? 'action required' : 'optional'}
                      </Badge>
                    ) : (
                      <Badge variant="destructive">fail</Badge>
                    )}
                  </TableCell>
                  {/* `break-all` + `max-w-md` keeps long values (DKIM public
                      keys, full URLs, hex digests, MX lists) inside their
                      column instead of stretching the whole table off-screen. */}
                  <TableCell className="max-w-md break-all font-mono text-xs">
                    {ch.expected}
                  </TableCell>
                  <TableCell
                    className={
                      'max-w-md break-all ' + (isOperatorAction ? 'text-xs' : 'font-mono text-xs')
                    }
                  >
                    <div className="flex flex-col gap-2">
                      <span>{ch.actual}</span>
                      {inlineFix && (
                        <Button
                          size="sm"
                          onClick={() => {
                            void inlineFix.run();
                          }}
                          disabled={inlineFix.pending}
                        >
                          {inlineFix.pending ? 'Working…' : inlineFix.label}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

// ---------- Inbound TLS hardening (DNS & TLS tab) ----------

interface InboundTlsActions {
  enableMtaSts: () => void;
  enableMtaStsPending: boolean;
  promoteMtaStsRequest: () => void;
  disableMtaStsRequest: () => void;
  enableTlsRpt: () => void;
  enableTlsRptPending: boolean;
  disableTlsRptRequest: () => void;
}

function InboundTlsCard({ d, actions }: { d: DomainPayload; actions: InboundTlsActions }) {
  return (
    <section className="rounded-md border border-[var(--color-border)] p-4">
      <SectionTitle icon={<Lock className="h-4 w-4" />} title="Inbound TLS hardening" />
      <p className="mb-3 text-sm text-[var(--color-muted-foreground)]">
        MTA-STS (RFC 8461) and TLS-RPT (RFC 8460) harden inbound TLS for this domain. Unlike
        DKIM/SPF/DMARC, MTA-STS records require explicit operator action — use the buttons below to
        publish, promote, or remove them.
      </p>
      <MetaList className="mb-3">
        <MetaRow label="MTA-STS mode">
          <Badge
            variant={
              d.mta_sts_mode === 'enforce'
                ? 'success'
                : d.mta_sts_mode === 'testing'
                  ? 'secondary'
                  : 'outline'
            }
          >
            {d.mta_sts_mode ?? 'none'}
          </Badge>
        </MetaRow>
        <MetaRow label="Policy id" valueClassName="font-mono text-xs">
          {d.mta_sts_policy_id ?? '—'}
        </MetaRow>
        <MetaRow label="Max age">
          {d.mta_sts_max_age != null ? `${d.mta_sts_max_age}s` : '—'}
        </MetaRow>
        <MetaRow label="MTA-STS verified">
          <span title={d.mta_sts_verified_at ?? undefined}>
            {d.mta_sts_verified_at ? formatRelative(d.mta_sts_verified_at) : 'never'}
          </span>
        </MetaRow>
        <MetaRow label="TLS-RPT enabled">{d.tlsrpt_enabled === 1 ? 'yes' : 'no'}</MetaRow>
        <MetaRow label="TLS-RPT rua" valueClassName="font-mono text-xs">
          {d.tlsrpt_rua ?? '—'}
        </MetaRow>
        <MetaRow label="TLS-RPT verified">
          <span title={d.tlsrpt_verified_at ?? undefined}>
            {d.tlsrpt_verified_at ? formatRelative(d.tlsrpt_verified_at) : 'never'}
          </span>
        </MetaRow>
      </MetaList>
      <div className="flex flex-wrap gap-2">
        {(!d.mta_sts_mode || d.mta_sts_mode === 'none') && (
          <Button size="sm" onClick={actions.enableMtaSts} disabled={actions.enableMtaStsPending}>
            Enable MTA-STS (testing)
          </Button>
        )}
        {d.mta_sts_mode === 'testing' && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={actions.enableMtaSts}
              disabled={actions.enableMtaStsPending}
            >
              Re-publish MTA-STS
            </Button>
            <Button size="sm" onClick={actions.promoteMtaStsRequest}>
              Promote to enforce
            </Button>
          </>
        )}
        {d.mta_sts_mode === 'enforce' && (
          <Button
            size="sm"
            variant="outline"
            onClick={actions.enableMtaSts}
            disabled={actions.enableMtaStsPending}
          >
            Re-publish MTA-STS
          </Button>
        )}
        {d.mta_sts_mode && d.mta_sts_mode !== 'none' && (
          <Button size="sm" variant="outline" onClick={actions.disableMtaStsRequest}>
            Disable MTA-STS
          </Button>
        )}
        {d.tlsrpt_enabled !== 1 && (
          <Button size="sm" onClick={actions.enableTlsRpt} disabled={actions.enableTlsRptPending}>
            Enable TLS-RPT
          </Button>
        )}
        {d.tlsrpt_enabled === 1 && (
          <Button size="sm" variant="outline" onClick={actions.disableTlsRptRequest}>
            Disable TLS-RPT
          </Button>
        )}
      </div>
    </section>
  );
}

// ---------- DMARC promotion subsection (DMARC tab) ----------

function DmarcPromotionCard({
  domainId,
  promotion,
  isLoading,
}: {
  domainId: string;
  promotion?: DmarcPromotionRow;
  isLoading: boolean;
}) {
  const pause = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/dmarc-promotion/${domainId}/pause`, method: 'POST' }),
    { invalidateKeys: [dmarcPromotionKeys.all], successMessage: 'DMARC promotion paused.' },
  );
  const resume = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/dmarc-promotion/${domainId}/resume`, method: 'POST' }),
    { invalidateKeys: [dmarcPromotionKeys.all], successMessage: 'DMARC promotion resumed.' },
  );
  const claim = useAdminMutation<unknown, undefined>(
    () => ({
      path: `/api/admin/dmarc-promotion/${domainId}/claim-management`,
      method: 'POST',
    }),
    { invalidateKeys: [dmarcPromotionKeys.all], successMessage: 'Claimed DNS management.' },
  );

  return (
    <section className="rounded-md border border-[var(--color-border)] p-4">
      <SectionTitle icon={<Flag className="h-4 w-4" />} title="Promotion" />
      {isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : !promotion ? (
        <EmptyState
          icon={<Flag className="h-5 w-5" />}
          title="No promotion state yet"
          description="The promotion cron has not seen this domain. It will appear here on the next scheduled run, or when you first claim DNS management."
        />
      ) : (
        <div className="space-y-3">
          <MetaList>
            <MetaRow label="Current policy" valueClassName="font-mono text-xs">
              p={promotion.dmarc_policy ?? 'none'}
            </MetaRow>
            <MetaRow label="Promotion state">
              <Badge
                variant={
                  promotion.dmarc_promotion_state === 'reject'
                    ? 'success'
                    : promotion.dmarc_promotion_state === 'paused'
                      ? 'destructive'
                      : 'secondary'
                }
              >
                {promotion.dmarc_promotion_state}
              </Badge>
            </MetaRow>
            <MetaRow label="Mode">
              <Badge
                variant={
                  promotion.dmarc_promotion_mode === 'auto'
                    ? 'success'
                    : promotion.dmarc_promotion_mode === 'paused'
                      ? 'destructive'
                      : 'secondary'
                }
              >
                {promotion.dmarc_promotion_mode}
              </Badge>
            </MetaRow>
            <MetaRow label="DNS managed">
              <Badge variant={promotion.dmarc_record_managed_by_polaris ? 'success' : 'outline'}>
                {promotion.dmarc_record_managed_by_polaris ? 'yes' : 'no'}
              </Badge>
            </MetaRow>
            <MetaRow label="Last transition">
              <span className="text-xs text-[var(--color-muted-foreground)]">
                {promotion.dmarc_promotion_last_at
                  ? formatRelative(promotion.dmarc_promotion_last_at)
                  : 'never'}
              </span>
            </MetaRow>
          </MetaList>
          <div className="flex flex-wrap gap-2">
            {promotion.dmarc_promotion_mode === 'auto' ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => pause.mutate(undefined)}
                disabled={pause.isPending}
              >
                Pause auto-promotion
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => resume.mutate(undefined)}
                disabled={resume.isPending}
              >
                Resume auto-promotion
              </Button>
            )}
            {promotion.dmarc_record_managed_by_polaris === 0 ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => claim.mutate(undefined)}
                disabled={claim.isPending}
                title="Opt in to letting Polaris write _dmarc DNS records for this domain"
              >
                Claim DNS management
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

// ---------- DMARC alignment summary (DMARC tab) ----------

function DmarcAlignmentCard({ domainName }: { domainName: string }) {
  const q = useAdminQuery<DmarcSummaryPayload>(
    dmarcKeys.summary(domainName),
    `/api/admin/dmarc-reports/summary?domain=${encodeURIComponent(domainName)}`,
    { staleTime: 60_000 },
  );
  return (
    <section className="rounded-md border border-[var(--color-border)] p-4">
      <SectionTitle icon={<ShieldCheck className="h-4 w-4" />} title="Alignment summary" />
      {q.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : q.error || !q.data ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">
          No DMARC aggregate reports yet. Ensure the domain's <code>_dmarc</code> record's{' '}
          <code>rua=</code> field includes <code>mailto:dmarc-rua@plrs.im</code>.
        </p>
      ) : q.data.last_30d.reports === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">
          No DMARC aggregate reports yet. Ensure the domain's <code>_dmarc</code> record's{' '}
          <code>rua=</code> field includes <code>mailto:dmarc-rua@plrs.im</code>.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <AlignmentWindow label="7-day" w={q.data.last_7d} />
            <AlignmentWindow label="14-day" w={q.data.last_14d} />
            <AlignmentWindow label="30-day" w={q.data.last_30d} />
          </div>
          <div className="text-xs text-[var(--color-muted-foreground)]">
            Last report{' '}
            <span title={q.data.last_30d.last_seen_at ?? ''}>
              {q.data.last_30d.last_seen_at ? formatRelative(q.data.last_30d.last_seen_at) : '—'}
            </span>
            .
          </div>
        </div>
      )}
    </section>
  );
}

function AlignmentWindow({ label, w }: { label: string; w: DmarcSummaryWindow }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-3">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
        {label}
      </div>
      <div className="flex items-baseline gap-2">
        <Badge variant={pctVariant(w.dmarc_pass_pct)}>{w.dmarc_pass_pct}%</Badge>
        <span className="text-xs text-[var(--color-muted-foreground)]">DMARC pass</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-0.5 text-xs">
        <span className="text-[var(--color-muted-foreground)]">DKIM</span>
        <span>{w.dkim_pass_pct}%</span>
        <span className="text-[var(--color-muted-foreground)]">SPF</span>
        <span>{w.spf_pass_pct}%</span>
        <span className="text-[var(--color-muted-foreground)]">Volume</span>
        <span>{w.total.toLocaleString()}</span>
        <span className="text-[var(--color-muted-foreground)]">Reports</span>
        <span>{w.reports}</span>
      </div>
    </div>
  );
}

// ---------- TLS-RPT summary (DMARC tab — sits under alignment) ----------

function TlsReportCard({ domainName }: { domainName: string }) {
  const q = useAdminQuery<TlsReportSummaryPayload>(
    tlsRptKeys.summary(domainName),
    `/api/admin/tls-rpt-reports/summary?domain=${encodeURIComponent(domainName)}`,
    { staleTime: 60_000 },
  );
  return (
    <section className="rounded-md border border-[var(--color-border)] p-4">
      <SectionTitle icon={<Lock className="h-4 w-4" />} title="TLS-RPT summary" />
      {q.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : q.error || !q.data || q.data.last_30d.reports === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">
          No TLS-RPT reports received yet for this domain.
        </p>
      ) : (
        <>
          <MetaList className="mb-3">
            <MetaRow label="7d reports">{q.data.last_7d.reports}</MetaRow>
            <MetaRow label="30d reports">{q.data.last_30d.reports}</MetaRow>
            <MetaRow label="7d success">{q.data.last_7d.success.toLocaleString()}</MetaRow>
            <MetaRow label="7d failures">
              {q.data.last_7d.failure > 0 ? (
                <Badge variant="destructive">{q.data.last_7d.failure.toLocaleString()}</Badge>
              ) : (
                q.data.last_7d.failure.toLocaleString()
              )}
            </MetaRow>
            <MetaRow label="Last report">
              <span title={q.data.last_30d.latest_at ?? ''}>
                {q.data.last_30d.latest_at ? formatRelative(q.data.last_30d.latest_at) : '—'}
              </span>
            </MetaRow>
          </MetaList>
          {q.data.top_failures_7d.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Failure type (7d)</TableHead>
                  <TableHead>Failed sessions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {q.data.top_failures_7d.map((f) => (
                  <TableRow key={f.result_type}>
                    <TableCell className="font-mono text-xs">{f.result_type}</TableCell>
                    <TableCell>{f.failed.toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </section>
  );
}

// ---------- Activity tab: senders bound + recent transitions ----------

function SendersCard({ domainId }: { domainId: string }) {
  const q = useAdminQuery<{ data: SenderRow[] }>(
    [...domainKeys.detail(domainId), 'senders'] as const,
    `/api/admin/domains/${domainId}/senders`,
  );
  const rows = q.data?.data ?? [];
  return (
    <section className="rounded-md border border-[var(--color-border)] p-4">
      <SectionTitle
        icon={<Users className="h-4 w-4" />}
        title="Senders bound to this domain"
        trailing={
          rows.length > 0 ? (
            <span className="text-xs text-[var(--color-muted-foreground)]">
              {rows.length} total
            </span>
          ) : null
        }
      />
      {q.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Users className="h-5 w-5" />}
          title="No senders bound yet"
          description="Senders show up here when a mailbox declares an outbound address on this domain."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Address</TableHead>
              <TableHead>Mailbox</TableHead>
              <TableHead>Default</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Added</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-mono text-xs">{s.address}</TableCell>
                <TableCell className="font-mono text-xs">
                  <Link
                    to="/mailboxes/$id"
                    params={{ id: s.mailbox_id }}
                    className="underline hover:text-[var(--color-foreground)]"
                  >
                    {s.mailbox_id}
                  </Link>
                </TableCell>
                <TableCell>
                  {s.default_for_mailbox ? <Badge variant="success">default</Badge> : '—'}
                </TableCell>
                <TableCell>
                  {s.disabled_at ? (
                    <Badge variant="secondary">disabled</Badge>
                  ) : (
                    <Badge variant="success">active</Badge>
                  )}
                </TableCell>
                <TableCell title={s.created_at}>{formatRelative(s.created_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function TransitionTimelineCard({ d }: { d: DomainPayload }) {
  // A small ledger of "when did this state change last" so the operator
  // doesn't have to scroll the audit log for the common questions
  // ("when was this last verified?", "when did we publish MTA-STS?").
  const entries: Array<{ when: string | null | undefined; label: string }> = [
    { when: d.created_at, label: 'Domain created' },
    { when: d.verified_at, label: 'Last verified OK' },
    { when: d.last_verify_check_at, label: 'Last verify attempt' },
    { when: d.mta_sts_verified_at, label: 'MTA-STS verified' },
    { when: d.tlsrpt_verified_at, label: 'TLS-RPT verified' },
    { when: d.updated_at, label: 'Row last updated' },
  ].filter((e) => e.when);
  return (
    <section className="rounded-md border border-[var(--color-border)] p-4">
      <SectionTitle icon={<Activity className="h-4 w-4" />} title="Recent transitions" />
      {entries.length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">No recorded transitions yet.</p>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {entries.map((e) => (
            <li
              key={e.label}
              className="flex items-baseline justify-between gap-3 border-b border-[var(--color-border)] py-1 last:border-b-0"
            >
              <span className="text-[var(--color-muted-foreground)]">{e.label}</span>
              <span className="font-mono text-xs" title={e.when ?? undefined}>
                {formatRelative(e.when)} · {formatDate(e.when)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------- Top-level page ----------

export function DomainDetail() {
  const { id } = useParams({ from: '/domains/$id' });
  const search = useSearch({ from: '/domains/$id' }) as DomainDetailSearch;
  const navigate = useNavigate();
  const tab: DomainTab = search.tab ?? 'overview';

  const q = useAdminQuery<DomainPayload>(domainKeys.detail(id), `/api/admin/domains/${id}`);
  const promotionQ = useAdminQuery<{ data: DmarcPromotionRow[] }>(
    dmarcPromotionKeys.list(),
    '/api/admin/dmarc-promotion',
    { staleTime: 60_000 },
  );
  const promotion = useMemo(
    () => (promotionQ.data?.data ?? []).find((r) => r.id === id),
    [promotionQ.data, id],
  );

  // Confirmation dialog state.
  const [confirmRotateDkim, setConfirmRotateDkim] = useState(false);
  const [confirmDisableInbound, setConfirmDisableInbound] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmPromoteMtaSts, setConfirmPromoteMtaSts] = useState(false);
  const [confirmDisableMtaSts, setConfirmDisableMtaSts] = useState(false);
  const [confirmDisableTlsRpt, setConfirmDisableTlsRpt] = useState(false);

  // Mutations.
  const rotate = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/domains/${id}/rotate-dkim`, method: 'POST' }),
    { invalidateKeys: [domainKeys.detail(id)], successMessage: 'DKIM rotated.' },
  );
  const enableInbound = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/domains/${id}/inbound/enable`, method: 'POST' }),
    { invalidateKeys: [domainKeys.detail(id)], successMessage: 'Inbound enabled.' },
  );
  const disableInbound = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/domains/${id}/inbound/disable`, method: 'POST' }),
    { invalidateKeys: [domainKeys.detail(id)], successMessage: 'Inbound disabled.' },
  );
  const remove = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/domains/${id}`, method: 'DELETE' }),
    { invalidateKeys: [domainKeys.all], successMessage: 'Domain deleted.' },
  );
  const enableMtaSts = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/domains/${id}/mta-sts/enable`, method: 'POST' }),
    { invalidateKeys: [domainKeys.detail(id)], successMessage: 'MTA-STS enabled (testing mode).' },
  );
  const promoteMtaSts = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/domains/${id}/mta-sts/promote`, method: 'POST' }),
    { invalidateKeys: [domainKeys.detail(id)], successMessage: 'MTA-STS promoted to enforce.' },
  );
  const disableMtaSts = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/domains/${id}/mta-sts/disable`, method: 'POST' }),
    { invalidateKeys: [domainKeys.detail(id)], successMessage: 'MTA-STS disabled.' },
  );
  const enableTlsRpt = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/domains/${id}/tls-rpt/enable`, method: 'POST' }),
    { invalidateKeys: [domainKeys.detail(id)], successMessage: 'TLS-RPT enabled.' },
  );
  const disableTlsRpt = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/domains/${id}/tls-rpt/disable`, method: 'POST' }),
    { invalidateKeys: [domainKeys.detail(id)], successMessage: 'TLS-RPT disabled.' },
  );

  const breadcrumbs = [{ label: 'Domains', to: '/domains' }, { label: q.data?.name ?? id }];

  if (q.isLoading) {
    return (
      <PageCard title="Domain" breadcrumbs={breadcrumbs} decorative>
        <Skeleton className="h-32 w-full" />
      </PageCard>
    );
  }
  if (q.error || !q.data) {
    return (
      <PageCard title="Domain" breadcrumbs={breadcrumbs} decorative>
        <ErrorText error={q.error ?? 'Not found.'} />
      </PageCard>
    );
  }
  const d = q.data;
  const risks = risksFor(d, promotion);

  const inboundOn = d.inbound_enabled !== 0;

  // Header actions — the one-click stuff that operators reach for on
  // every visit. Less-common destructive ops live near their relevant
  // section in the tabs.
  const headerActions = (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setConfirmRotateDkim(true)}
        disabled={rotate.isPending}
      >
        <Key className="h-3.5 w-3.5" />
        Rotate DKIM
      </Button>
      {inboundOn ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setConfirmDisableInbound(true)}
          disabled={disableInbound.isPending}
        >
          <MailX className="h-3.5 w-3.5" />
          Disable inbound
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={() => enableInbound.mutate(undefined)}
          disabled={enableInbound.isPending}
        >
          <MailCheck className="h-3.5 w-3.5" />
          Enable inbound
        </Button>
      )}
      <Button
        size="sm"
        variant="destructive"
        onClick={() => setConfirmDelete(true)}
        disabled={remove.isPending}
      >
        Delete
      </Button>
    </>
  );

  const description = (
    <>
      <span className="font-mono">DKIM selector: {d.dkim_selector ?? 'cf'}</span>
      <span className="mx-2 text-[var(--color-muted-foreground)]">·</span>
      <span>
        Inbound{' '}
        <span className={inboundOn ? 'text-[var(--color-success)]' : 'text-[var(--color-warning)]'}>
          {inboundOn ? 'enabled' : 'disabled'}
        </span>
      </span>
      <span className="mx-2 text-[var(--color-muted-foreground)]">·</span>
      <span className="text-xs text-[var(--color-muted-foreground)]">{TAB_DESCRIPTIONS[tab]}</span>
    </>
  );

  return (
    <PageCard
      title={d.name}
      breadcrumbs={breadcrumbs}
      description={description}
      actions={headerActions}
      decorative
    >
      <div className="space-y-6">
        <HealthHero d={d} promotion={promotion} />
        <RiskBanner risks={risks} />

        <Tabs
          value={tab}
          onValueChange={(v) => {
            void navigate({
              to: '/domains/$id',
              params: { id },
              search: { tab: v as DomainTab },
            });
          }}
        >
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="dns">DNS &amp; TLS</TabsTrigger>
            <TabsTrigger value="dmarc">DMARC</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <div className="grid gap-4 md:grid-cols-2">
              <section className="rounded-md border border-[var(--color-border)] p-4">
                <SectionTitle icon={<Globe2 className="h-4 w-4" />} title="Metadata" />
                <MetaList>
                  <MetaRow label="Name" valueClassName="font-mono text-xs">
                    {d.name}
                  </MetaRow>
                  <MetaRow label="ID" valueClassName="font-mono text-xs">
                    {d.id}
                  </MetaRow>
                  <MetaRow label="Status">
                    <Badge variant={d.status === 'verified' ? 'success' : 'secondary'}>
                      {d.status}
                    </Badge>
                  </MetaRow>
                  <MetaRow label="DKIM selector" valueClassName="font-mono text-xs">
                    {d.dkim_selector ?? '—'}
                  </MetaRow>
                  <MetaRow label="DMARC policy" valueClassName="font-mono text-xs">
                    p={promotion?.dmarc_policy ?? d.dmarc_policy ?? 'none'}
                  </MetaRow>
                  <MetaRow label="DMARC rua" valueClassName="font-mono text-xs break-all">
                    {d.dmarc_rua ?? '—'}
                  </MetaRow>
                  <MetaRow label="Inbound">
                    <Badge variant={inboundOn ? 'success' : 'destructive'}>
                      {inboundOn ? 'enabled' : 'disabled'}
                    </Badge>
                  </MetaRow>
                  <MetaRow label="Outbound">
                    <Badge variant={d.outbound_enabled !== 0 ? 'success' : 'secondary'}>
                      {d.outbound_enabled !== 0 ? 'enabled' : 'disabled'}
                    </Badge>
                  </MetaRow>
                  <MetaRow label="Created">
                    <span title={d.created_at ?? undefined}>{formatRelative(d.created_at)}</span>
                  </MetaRow>
                  <MetaRow label="Verified">
                    <span title={d.verified_at ?? undefined}>{formatRelative(d.verified_at)}</span>
                  </MetaRow>
                </MetaList>
              </section>

              <TransitionTimelineCard d={d} />
            </div>
          </TabsContent>

          <TabsContent value="dns">
            <div className="space-y-4">
              <DnsChecklist
                id={id}
                domainName={d.name}
                onEnableMtaSts={async () => {
                  await enableMtaSts.mutateAsync(undefined);
                }}
                onEnableTlsRpt={async () => {
                  await enableTlsRpt.mutateAsync(undefined);
                }}
                enableMtaStsPending={enableMtaSts.isPending}
                enableTlsRptPending={enableTlsRpt.isPending}
              />
              <CfZoneCard domainName={d.name} />
              <InboundTlsCard
                d={d}
                actions={{
                  enableMtaSts: () => enableMtaSts.mutate(undefined),
                  enableMtaStsPending: enableMtaSts.isPending,
                  promoteMtaStsRequest: () => setConfirmPromoteMtaSts(true),
                  disableMtaStsRequest: () => setConfirmDisableMtaSts(true),
                  enableTlsRpt: () => enableTlsRpt.mutate(undefined),
                  enableTlsRptPending: enableTlsRpt.isPending,
                  disableTlsRptRequest: () => setConfirmDisableTlsRpt(true),
                }}
              />
            </div>
          </TabsContent>

          <TabsContent value="dmarc">
            <div className="space-y-4">
              <DmarcPromotionCard
                domainId={d.id}
                promotion={promotion}
                isLoading={promotionQ.isLoading}
              />
              <DmarcAlignmentCard domainName={d.name} />
              <TlsReportCard domainName={d.name} />
            </div>
          </TabsContent>

          <TabsContent value="activity">
            <div className="space-y-4">
              <SendersCard domainId={d.id} />
              <TransitionTimelineCard d={d} />
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <DestructiveActionDialog
        open={confirmRotateDkim}
        onOpenChange={setConfirmRotateDkim}
        action="Rotate DKIM"
        name={d.name}
        blastRadius={[
          'A new DKIM selector is generated; the previous selector stops signing',
          'Outbound mail will fail DKIM until the new selector is published in DNS',
          'You must update DNS with the new selector before mail flow resumes',
        ]}
        reversible={false}
        onConfirm={async () => {
          await rotate.mutateAsync(undefined);
          setConfirmRotateDkim(false);
        }}
        isPending={rotate.isPending}
      />

      <DestructiveActionDialog
        open={confirmDisableInbound}
        onOpenChange={setConfirmDisableInbound}
        action="Disable inbound"
        name={d.name}
        blastRadius={[
          'All receivers on this domain stop accepting mail',
          'Senders will see deferral or rejection at the MX level',
          'You can re-enable inbound at any time',
        ]}
        reversible
        confirmLabel="Disable inbound"
        onConfirm={async () => {
          await disableInbound.mutateAsync(undefined);
          setConfirmDisableInbound(false);
        }}
        isPending={disableInbound.isPending}
      />

      <DestructiveActionDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        action="Delete domain"
        name={d.name}
        blastRadius={[
          'All senders bound to this domain are revoked',
          'All receivers on this domain stop accepting mail',
          'DKIM selectors and DNS expectations are removed',
          'Existing message rows are retained for audit',
        ]}
        reversible={false}
        typedConfirmation={d.name}
        confirmLabel="Delete domain"
        onConfirm={async () => {
          await remove.mutateAsync(undefined);
          setConfirmDelete(false);
        }}
        isPending={remove.isPending}
      />

      <DestructiveActionDialog
        open={confirmPromoteMtaSts}
        onOpenChange={setConfirmPromoteMtaSts}
        action="Promote MTA-STS to enforce"
        name={d.name}
        blastRadius={[
          'Sending MTAs that fail TLS to *.mx.cloudflare.net will REJECT mail',
          'Previously cached `testing` policies will refresh on their next max_age expiry',
          'A new policy id is minted; senders re-fetch immediately',
        ]}
        reversible
        confirmLabel="Promote to enforce"
        onConfirm={async () => {
          await promoteMtaSts.mutateAsync(undefined);
          setConfirmPromoteMtaSts(false);
        }}
        isPending={promoteMtaSts.isPending}
      />

      <DestructiveActionDialog
        open={confirmDisableMtaSts}
        onOpenChange={setConfirmDisableMtaSts}
        action="Disable MTA-STS"
        name={d.name}
        blastRadius={[
          'DNS TXT _mta-sts.{name} is deleted',
          'Worker custom domain mta-sts.{name} is detached',
          'Senders with cached policies will follow them until max_age expires',
          'You can re-enable later via Enable MTA-STS',
        ]}
        reversible
        confirmLabel="Disable MTA-STS"
        onConfirm={async () => {
          await disableMtaSts.mutateAsync(undefined);
          setConfirmDisableMtaSts(false);
        }}
        isPending={disableMtaSts.isPending}
      />

      <DestructiveActionDialog
        open={confirmDisableTlsRpt}
        onOpenChange={setConfirmDisableTlsRpt}
        action="Disable TLS-RPT"
        name={d.name}
        blastRadius={[
          'DNS TXT _smtp._tls.{name} is deleted',
          'Senders stop sending TLS failure reports',
          'You can re-enable later via Enable TLS-RPT',
        ]}
        reversible
        confirmLabel="Disable TLS-RPT"
        onConfirm={async () => {
          await disableTlsRpt.mutateAsync(undefined);
          setConfirmDisableTlsRpt(false);
        }}
        isPending={disableTlsRpt.isPending}
      />
    </PageCard>
  );
}
