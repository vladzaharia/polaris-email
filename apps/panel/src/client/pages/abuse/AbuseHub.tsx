// Abuse & alerts hub — consolidates the previously-separate /reports/abuse,
// /reports/triage, /admin-alerts, /sender-abuse pages into a single tabbed
// view. URL search-param `?tab=complaints|triage|alerts|senders` keeps deep
// links working (runbooks pin specific tabs); default is `complaints` since
// it's the most operator-actionable inbox.
import { useNavigate, useSearch, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownUp,
  AtSign,
  BellRing,
  Play,
  ShieldAlert,
  Tag,
  Workflow,
} from 'lucide-react';
import { PageCard } from '../../layouts/PageCard.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/tabs.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { SegmentedControl } from '../../components/SegmentedControl.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Label } from '../../components/ui/label.js';
import { FilterBar, type FilterSpec } from '../../components/FilterBar.js';
import { FilterAddressPicker, FilterEnumPicker } from '../../components/filters/index.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { abuseEventKeys, adminAlertKeys, senderAbuseKeys, triageKeys } from '../../queryKeys.js';
import { formatRelative } from '../../lib/format.js';
import { ErrorText } from '../../components/ErrorText.js';
import { EmptyState } from '../../components/EmptyState.js';
import { CreateSuppressionDialog, SuppressionsTable } from '../suppressions/List.js';

type TabKey = 'complaints' | 'triage' | 'alerts' | 'senders' | 'suppressions';

interface AbuseHubSearch {
  tab?: TabKey;
}

// ---------- Complaints tab (ARF/DSN abuse events) ----------

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

const COMPLAINT_SOURCES = [
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
  caused_suppression_id: string | null;
  reported_at: string;
}

function ComplaintsTab() {
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
  const q = useAdminQuery<{ data: AbuseEventRow[] }>(abuseEventKeys.list(filters), path);
  const rows = q.data?.data ?? [];

  const filterSpecs: FilterSpec[] = [
    {
      id: 'sender_address',
      label: 'Sender address',
      icon: AtSign,
      value: sender || null,
      onChange: (next) => setSender(typeof next === 'string' ? next : ''),
      render: ({ close }) => (
        <FilterAddressPicker
          value={sender || null}
          onChange={(v) => setSender(v ?? '')}
          close={close}
          placeholder="exact sender address"
        />
      ),
    },
    {
      id: 'classification',
      label: 'Classification',
      icon: ShieldAlert,
      value: classification || null,
      onChange: (next) => setClassification(typeof next === 'string' ? next : ''),
      render: ({ close }) => (
        <FilterEnumPicker
          options={CLASSIFICATIONS.map((c) => ({ value: c }))}
          value={classification || null}
          onChange={(v) => setClassification(v ?? '')}
          close={close}
        />
      ),
    },
    {
      id: 'source',
      label: 'Source',
      icon: Workflow,
      value: source || null,
      onChange: (next) => setSource(typeof next === 'string' ? next : ''),
      render: ({ close }) => (
        <FilterEnumPicker
          options={COMPLAINT_SOURCES.map((s) => ({ value: s }))}
          value={source || null}
          onChange={(v) => setSource(v ?? '')}
          close={close}
        />
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <FilterBar filters={filterSpecs} />
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
                  <StatusBadge kind="classification" value={r.classification} />
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
                    <span className="text-xs text-[var(--color-muted-foreground)]">none</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// ---------- Triage tab (LLM-classified events) ----------

const TRIAGE_CATEGORIES = [
  'spam_complaint',
  'phishing_report',
  'bounce_notification',
  'mailing_list_admin',
  'legal_takedown',
  'inquiry',
  'auto_reply',
  'noise',
] as const;
const TRIAGE_SEVERITIES = ['info', 'warn', 'critical'] as const;

interface TriageRow {
  id: string;
  model: string;
  category: string;
  severity: 'info' | 'warn' | 'critical';
  confidence: number;
  actionable: number;
  target_recipient: string | null;
  summary: string | null;
  applied_suppression_id: string | null;
  created_at: string;
}

function TriageTab() {
  const [category, setCategory] = useState('');
  const [severity, setSeverity] = useState('');
  const [sort, setSort] = useState<'created' | 'low_confidence'>('low_confidence');
  const filters = useMemo(() => {
    const f: Record<string, string> = {};
    if (category) f.category = category;
    if (severity) f.severity = severity;
    if (sort === 'low_confidence') f.sort = 'low_confidence';
    return f;
  }, [category, severity, sort]);
  const path = useMemo(() => {
    const q = new URLSearchParams(filters);
    return q.toString() ? `/api/admin/triage-events?${q.toString()}` : '/api/admin/triage-events';
  }, [filters]);
  const q = useAdminQuery<{ data: TriageRow[] }>(triageKeys.list(filters), path);
  const rows = q.data?.data ?? [];

  const filterSpecs: FilterSpec[] = [
    {
      id: 'category',
      label: 'Category',
      icon: Tag,
      value: category || null,
      onChange: (next) => setCategory(typeof next === 'string' ? next : ''),
      render: ({ close }) => (
        <FilterEnumPicker
          options={TRIAGE_CATEGORIES.map((c) => ({ value: c }))}
          value={category || null}
          onChange={(v) => setCategory(v ?? '')}
          close={close}
        />
      ),
    },
    {
      id: 'severity',
      label: 'Severity',
      icon: AlertTriangle,
      value: severity || null,
      onChange: (next) => setSeverity(typeof next === 'string' ? next : ''),
      render: ({ close }) => (
        <FilterEnumPicker
          options={TRIAGE_SEVERITIES.map((s) => ({ value: s }))}
          value={severity || null}
          onChange={(v) => setSeverity(v ?? '')}
          close={close}
        />
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <FilterBar
        filters={filterSpecs}
        // Sort is always set (`'created' | 'low_confidence'`), so it doesn't
        // fit the chip-and-popover pattern (which assumes an unset/"Any"
        // state). Render the original Select via the children escape hatch.
      >
        <div className="flex items-center gap-2">
          <ArrowDownUp
            size={14}
            aria-hidden="true"
            className="text-[var(--color-muted-foreground)]"
          />
          <Label htmlFor="triage-sort" className="text-xs">
            Sort
          </Label>
          <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
            <SelectTrigger id="triage-sort" className="h-8 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="low_confidence">Low confidence first</SelectItem>
              <SelectItem value="created">Newest first</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </FilterBar>
      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No triage events"
          description="Events show up here once the Workers AI binding classifies unstructured complaint mail at the platform aliases."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Confidence</TableHead>
              <TableHead>Actionable</TableHead>
              <TableHead>Recipient</TableHead>
              <TableHead>Summary</TableHead>
              <TableHead>Suppression</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell title={r.created_at}>{formatRelative(r.created_at)}</TableCell>
                <TableCell>
                  <StatusBadge kind="classification" value={r.category} />
                </TableCell>
                <TableCell>
                  <StatusBadge kind="severity" value={r.severity} />
                </TableCell>
                <TableCell>
                  <StatusBadge kind="confidence" value={r.confidence} />
                </TableCell>
                <TableCell>{r.actionable ? 'yes' : 'no'}</TableCell>
                <TableCell className="font-mono text-xs">{r.target_recipient ?? '—'}</TableCell>
                <TableCell className="max-w-md truncate" title={r.summary ?? ''}>
                  {r.summary ?? '—'}
                </TableCell>
                <TableCell>
                  {r.applied_suppression_id ? (
                    <Badge variant="success">fired</Badge>
                  ) : (
                    <Badge variant="outline">none</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// ---------- Alerts tab (admin_alerts history) ----------

const ALERT_TYPES = [
  'sender_suppressed',
  'phishing_report_received',
  'legal_takedown_received',
  'sender_threshold_breached',
  'tls_rpt_failure_burst',
  'dmarc_alignment_drop',
  'synthetic_check_failed',
  'manual',
] as const;

const ALERT_SEVERITIES = ['info', 'warn', 'critical'] as const;

interface AdminAlertRow {
  id: string;
  alert_type: string;
  severity: 'info' | 'warn' | 'critical';
  target: string;
  subject: string;
  delivery: string;
  created_at: string;
}

function AlertsTab() {
  const [type, setType] = useState('');
  const [severity, setSeverity] = useState('');
  const filters = useMemo(() => {
    const f: Record<string, string> = {};
    if (type) f.alert_type = type;
    if (severity) f.severity = severity;
    return f;
  }, [type, severity]);
  const path = useMemo(() => {
    const queryStr = new URLSearchParams(filters);
    return queryStr.toString() ? `/api/admin/alerts?${queryStr.toString()}` : '/api/admin/alerts';
  }, [filters]);
  const q = useAdminQuery<{ data: AdminAlertRow[] }>(adminAlertKeys.list(filters), path);
  const rows = q.data?.data ?? [];

  const filterSpecs: FilterSpec[] = [
    {
      id: 'alert_type',
      label: 'Type',
      icon: Tag,
      value: type || null,
      onChange: (next) => setType(typeof next === 'string' ? next : ''),
      render: ({ close }) => (
        <FilterEnumPicker
          options={ALERT_TYPES.map((t) => ({ value: t }))}
          value={type || null}
          onChange={(v) => setType(v ?? '')}
          close={close}
        />
      ),
    },
    {
      id: 'severity',
      label: 'Severity',
      icon: AlertTriangle,
      value: severity || null,
      onChange: (next) => setSeverity(typeof next === 'string' ? next : ''),
      render: ({ close }) => (
        <FilterEnumPicker
          options={ALERT_SEVERITIES.map((s) => ({ value: s }))}
          value={severity || null}
          onChange={(v) => setSeverity(v ?? '')}
          close={close}
        />
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <FilterBar filters={filterSpecs} />
      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No alerts yet"
          description="Alerts surface here when sender suppressions fire, phishing/legal reports come in, or synthetic checks fail. Press 'Send test alert' to verify the pipeline."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Delivery</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const delivery = (() => {
                try {
                  return JSON.parse(r.delivery) as Array<{ channel: string; ok: boolean }>;
                } catch {
                  return [];
                }
              })();
              return (
                <TableRow key={r.id}>
                  <TableCell title={r.created_at}>{formatRelative(r.created_at)}</TableCell>
                  <TableCell>
                    <StatusBadge kind="alert-severity" value={r.severity} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.alert_type}</TableCell>
                  <TableCell className="font-mono text-xs">{r.target}</TableCell>
                  <TableCell className="max-w-md truncate" title={r.subject}>
                    {r.subject}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {delivery.map((d) => `${d.channel}:${d.ok ? '✓' : '✗'}`).join(' ')}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// ---------- Senders tab (sender abuse profiles) ----------

interface ProfileRow {
  principal_type: 'sender_address' | 'mailbox' | 'domain';
  principal_id: string;
  lifetime_event_count: number;
  lifetime_weighted_score: number;
  suppression_count: number;
  current_tier: number;
  last_suppressed_at: string | null;
  last_event_at: string | null;
}

function SendersTab() {
  const [tier, setTier] = useState<string>('');
  const [type, setType] = useState<string>('');
  const filters = useMemo(() => {
    const f: Record<string, string> = {};
    if (tier) f.tier = tier;
    if (type) f.principal_type = type;
    return f;
  }, [tier, type]);
  const path = useMemo(() => {
    const q = new URLSearchParams(filters);
    return q.toString()
      ? `/api/admin/sender-abuse-profiles?${q.toString()}`
      : '/api/admin/sender-abuse-profiles';
  }, [filters]);
  const q = useAdminQuery<{ data: ProfileRow[] }>(senderAbuseKeys.list(filters), path);
  const rows = q.data?.data ?? [];

  const tierOptions = [
    { value: '0', label: 'Tier 0 (clean)' },
    { value: '1', label: 'Tier 1' },
    { value: '2', label: 'Tier 2' },
    { value: '3', label: 'Tier 3' },
    { value: '4', label: 'Tier 4' },
    { value: '5', label: 'Tier 5 (permanent)' },
  ];
  const principalTypeOptions = [
    { value: 'sender_address', label: 'Sender address' },
    { value: 'mailbox', label: 'Mailbox' },
    { value: 'domain', label: 'Domain' },
  ];

  const filterSpecs: FilterSpec[] = [
    {
      id: 'tier',
      label: 'Tier',
      icon: AlertTriangle,
      value: tier || null,
      onChange: (next) => setTier(typeof next === 'string' ? next : ''),
      render: ({ close }) => (
        <FilterEnumPicker
          options={tierOptions}
          value={tier || null}
          onChange={(v) => setTier(v ?? '')}
          close={close}
        />
      ),
      formatValue: (value) => {
        if (typeof value !== 'string' || !value) return '';
        return tierOptions.find((o) => o.value === value)?.label ?? value;
      },
    },
    {
      id: 'principal_type',
      label: 'Principal type',
      icon: Workflow,
      value: type || null,
      onChange: (next) => setType(typeof next === 'string' ? next : ''),
      render: ({ close }) => (
        <FilterEnumPicker
          options={principalTypeOptions}
          value={type || null}
          onChange={(v) => setType(v ?? '')}
          close={close}
        />
      ),
      formatValue: (value) => {
        if (typeof value !== 'string' || !value) return '';
        return principalTypeOptions.find((o) => o.value === value)?.label ?? value;
      },
    },
  ];

  return (
    <div className="space-y-4">
      <FilterBar filters={filterSpecs} />
      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No sender profiles"
          description="Profiles materialize when abuse_events accumulate against a sender. The threshold cron creates the first row per principal on its first fire."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>Principal</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead>Events (lifetime)</TableHead>
              <TableHead>Weighted score</TableHead>
              <TableHead>Suppressions fired</TableHead>
              <TableHead>Last event</TableHead>
              <TableHead>Last suppressed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={`${r.principal_type}:${r.principal_id}`}>
                <TableCell className="font-mono text-xs">{r.principal_type}</TableCell>
                <TableCell className="font-mono text-xs">{r.principal_id}</TableCell>
                <TableCell>
                  <StatusBadge kind="tier" value={r.current_tier} />
                </TableCell>
                <TableCell>{r.lifetime_event_count}</TableCell>
                <TableCell>{r.lifetime_weighted_score}</TableCell>
                <TableCell>{r.suppression_count}</TableCell>
                <TableCell title={r.last_event_at ?? ''}>
                  {r.last_event_at ? formatRelative(r.last_event_at) : '—'}
                </TableCell>
                <TableCell title={r.last_suppressed_at ?? ''}>
                  {r.last_suppressed_at ? formatRelative(r.last_suppressed_at) : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// ---------- Suppressions tab ----------
//
// The standalone /suppressions page used to host the Recipients/Senders split
// at the page level. Folded in here as the fifth tab, the recipient/sender
// choice becomes an inner toggle — same component, different chrome.

function SuppressionsTab() {
  const [scope, setScope] = useState<'recipient' | 'sender'>('recipient');
  return (
    <div className="space-y-4">
      <SegmentedControl<'recipient' | 'sender'>
        ariaLabel="Suppression scope"
        size="sm"
        options={[
          { value: 'recipient', label: 'Recipients' },
          { value: 'sender', label: 'Senders' },
        ]}
        value={scope}
        onChange={setScope}
      />
      <SuppressionsTable entityType={scope} />
    </div>
  );
}

// ---------- Hub shell ----------

const TAB_DESCRIPTIONS: Record<TabKey, string> = {
  complaints: 'Structured ARF/DSN ledger. Read-only; mutations live in the Suppressions tab.',
  triage: 'Workers AI classifications of unstructured complaint mail.',
  alerts: 'Operator-facing alert history with delivery telemetry.',
  senders: 'Per-principal abuse tier ledger; tiers never reset.',
  suppressions: 'Do-not-send list, scoped per recipient or sender.',
};

export function AbuseHub() {
  const search = useSearch({ from: '/abuse' }) as AbuseHubSearch;
  const navigate = useNavigate();
  const tab = (search.tab as TabKey | undefined) ?? 'complaints';

  // Per-tab action mutations live at the hub level so the buttons can render
  // in PageCard's header `actions` slot — every other list page does the same
  // (Add Domain, Add Mailbox, Add Suppression). One-word labels + icons.
  const sendTestAlert = useAdminMutation<{ id: string; deduped: boolean }, void>(
    () => ({ path: '/api/admin/alerts/test', method: 'POST' }),
    { invalidateKeys: [adminAlertKeys.all], successMessage: 'Test alert fired.' },
  );
  const runThresholdCron = useAdminMutation<{ fired: number; candidates: number }, void>(
    () => ({ path: '/api/admin/sender-abuse-threshold/run', method: 'POST' }),
    { invalidateKeys: [senderAbuseKeys.all], successMessage: 'Threshold cron triggered.' },
  );

  // Suppressions tab needs an inner recipient/sender toggle to pick which
  // scope the Add dialog applies to. We default to 'recipient' here so the
  // header action always points somewhere reasonable; once the tab is open
  // the inner toggle drives it. (Picking the right scope at click time would
  // require lifting tab state up — overkill for one button.)
  const suppressionAddScope: 'recipient' | 'sender' = 'recipient';

  const headerActions =
    tab === 'alerts' ? (
      <Button
        variant="outline"
        size="sm"
        onClick={() => sendTestAlert.mutate()}
        disabled={sendTestAlert.isPending}
        title="Fire a synthetic alert end-to-end through ALERT_WEBHOOK + dedupe"
      >
        <BellRing className="h-4 w-4" />
        {sendTestAlert.isPending ? 'Firing…' : 'Test'}
      </Button>
    ) : tab === 'senders' ? (
      <Button
        variant="outline"
        size="sm"
        onClick={() => runThresholdCron.mutate()}
        disabled={runThresholdCron.isPending}
        title="Run the abuse threshold cron immediately"
      >
        <Play className="h-4 w-4" />
        {runThresholdCron.isPending ? 'Running…' : 'Run'}
      </Button>
    ) : tab === 'suppressions' ? (
      <CreateSuppressionDialog entityType={suppressionAddScope} />
    ) : undefined;

  return (
    <PageCard
      title="Abuse & alerts"
      description={TAB_DESCRIPTIONS[tab]}
      decorative
      actions={headerActions}
    >
      <Tabs
        value={tab}
        onValueChange={(v) => {
          // Persist the active tab in the URL so deep links survive reloads
          // and operators can paste a runbook-ready URL into Slack.
          void navigate({ to: '/abuse', search: { tab: v as TabKey } });
        }}
      >
        <TabsList>
          <TabsTrigger value="complaints">Complaints</TabsTrigger>
          <TabsTrigger value="triage">Triage</TabsTrigger>
          <TabsTrigger value="alerts">Alerts</TabsTrigger>
          <TabsTrigger value="senders">Senders</TabsTrigger>
          <TabsTrigger value="suppressions">Suppressions</TabsTrigger>
        </TabsList>
        <TabsContent value="complaints">
          <ComplaintsTab />
        </TabsContent>
        <TabsContent value="triage">
          <TriageTab />
        </TabsContent>
        <TabsContent value="alerts">
          <AlertsTab />
        </TabsContent>
        <TabsContent value="senders">
          <SendersTab />
        </TabsContent>
        <TabsContent value="suppressions">
          <SuppressionsTab />
        </TabsContent>
      </Tabs>
    </PageCard>
  );
}
