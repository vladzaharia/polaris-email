// Message detail — rewritten 2026-05.
//
// What was wrong with the previous incarnation
// --------------------------------------------
// The old page treated `GET /api/messages/:id` as a JSON viewer: a flat
// definition list of From/To/Subject/Mailbox/Created followed by the
// pipeline strip followed by Text/HTML/Headers tabs and an attachments
// table. Everything was the same size and the same colour. The four
// distinct operator workflows that actually land here — outbound retry
// chase, inbound policy review, T&S audit, moderator hold/release — all
// had to scroll the same wall of meta to find their answer. The rich
// lifecycle timestamps (`queued_at`, `sending_at`, `sent_at`,
// `delivered_at`, `failed_at`, `last_error`, `bounce_metadata`) the wire
// payload ships were entirely invisible. SPF/DKIM/DMARC and the sender
// IP were buried in the Headers tab. Policy verdicts and DLQ rows lived
// behind a pipeline-strip tile click — a tile, not a panel — so reviewers
// never saw verdict reasons inline.
//
// What the new design optimises for
// ---------------------------------
// One header that answers "what is this" in a glance (subject + direction
// + status + relative time + action toolbar). The pipeline strip directly
// below it, no extra chrome. A two-column body: content on the left
// (largest cell, HTML default, falls back to Text or raw download), and
// a stacked sidebar on the right with addresses, the auth panel, and the
// raw-source affordance. A lifecycle table inlines every stage timestamp
// + the `last_error` / `bounce_metadata` when present. Policy decisions
// and DLQ rows render inline as compact tables — drill-in goes from
// "click the tile, navigate, scan list" to "read the verdict row right
// here, click the row to drill in".
import { useParams, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import {
  Ban,
  Code,
  Copy,
  ExternalLink,
  FileText,
  Globe,
  Inbox,
  Mail,
  Paperclip,
  RotateCcw,
  Send,
  Server,
  Shield,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { PageCard } from '../../layouts/PageCard.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../../components/ui/accordion.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { dlqKeys, messageKeys, policyKeys } from '../../queryKeys.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { StatTile } from '../../components/StatTile.js';
import { MetaList, MetaRow } from '../../components/MetaList.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorText } from '../../components/ErrorText.js';
import { formatDate, formatRelative } from '../../lib/format.js';
import { MessagePipelineStrip } from './MessagePipelineStrip.js';

// ---------- wire types ----------

interface MessagePayload {
  id: string;
  direction: 'in' | 'out';
  status: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  body_url?: string;
  headers?: Record<string, string>;
  header_message_id?: string;
  mailbox_id?: string;
  thread_id?: string;
  auth?: {
    spf?: string;
    dkim?: string;
    dmarc?: string;
    remote_ip?: string;
  };
  body_bytes?: number;
  attachments_total_bytes?: number;
  received_at_bridge?: string;
  received_at_api?: string;
  queued_at?: string;
  sending_at?: string;
  sent_at?: string;
  delivered_at?: string;
  failed_at?: string;
  bounce_metadata?: unknown;
  last_error?: string;
  created_at?: string;
  // Legacy bridge-style payload — kept for back-compat with older callers.
  bodies?: {
    text?: { inline?: string; url?: string; bytes?: number };
    html?: { inline?: string; url?: string; bytes?: number };
  };
  attachments?: Array<{
    filename: string;
    content_type: string;
    size_bytes?: number;
    bytes?: number;
    url?: string;
  }>;
}

interface PolicyDecisionRow {
  id: string;
  verdict: string;
  total_score: number;
  heuristic_reasons_json: string;
  llm_invoked: number;
  llm_label: string | null;
  llm_confidence: number | null;
  decided_at: string;
}

interface DlqRow {
  id: string;
  webhook_sub_id: string;
  last_status_code: number | null;
  last_error: string | null;
  attempts: number;
  dlq_at: string;
}

// ---------- helpers ----------

// Lifecycle row helper — `(label, iso)` becomes a `<tr>` if iso is set,
// otherwise nothing. Used by both inbound (received_at_*, queued_at,...)
// and outbound (queued_at, sending_at, sent_at, ...) paths.
interface StageRow {
  key: string;
  label: string;
  at: string | undefined;
}

function buildLifecycle(m: MessagePayload): StageRow[] {
  if (m.direction === 'out') {
    return [
      { key: 'created', label: 'Created', at: m.created_at },
      { key: 'queued', label: 'Queued', at: m.queued_at },
      { key: 'sending', label: 'Sending', at: m.sending_at },
      { key: 'sent', label: 'Sent', at: m.sent_at },
      { key: 'delivered', label: 'Delivered', at: m.delivered_at },
      { key: 'failed', label: 'Failed', at: m.failed_at },
    ];
  }
  return [
    { key: 'received_bridge', label: 'Received (bridge)', at: m.received_at_bridge },
    { key: 'received_api', label: 'Received (API)', at: m.received_at_api },
    { key: 'created', label: 'Persisted', at: m.created_at },
  ];
}

// Map a single auth-result string ("pass", "fail", "softfail", ...) to a
// Badge variant. Anything we don't recognise renders as outline so the
// raw string still shows up.
function authBadgeVariant(
  v: string | undefined,
): 'success' | 'destructive' | 'warning' | 'outline' | 'secondary' {
  if (!v) return 'outline';
  const lower = v.toLowerCase();
  if (lower === 'pass') return 'success';
  if (lower === 'fail') return 'destructive';
  if (lower === 'softfail' || lower === 'neutral' || lower === 'policy') return 'warning';
  if (lower === 'none' || lower === 'temperror' || lower === 'permerror') return 'secondary';
  return 'outline';
}

function formatBytes(n: number | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// `summariseReasons` — best-effort parse of the policy decision's
// heuristic reasons JSON. Failing parse falls back to the raw string so
// we never hide debugging signal from the operator.
function summariseReasons(json: string): string {
  if (!json) return '';
  try {
    const parsed = JSON.parse(json) as { reason_code: string; score: number }[];
    return parsed
      .slice(0, 4)
      .map((r) => `${r.reason_code} (${r.score})`)
      .join(', ');
  } catch {
    return json.slice(0, 120);
  }
}

// ---------- subcomponents ----------

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      type="button"
      aria-label={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      <Copy className="h-3.5 w-3.5" aria-hidden />
      <span>{copied ? 'Copied' : label}</span>
    </Button>
  );
}

function AddressList({ addrs }: { addrs: string[] | undefined }) {
  if (!addrs || addrs.length === 0) return <>—</>;
  return (
    <span className="font-mono text-xs">
      {addrs.map((a, i) => (
        <span key={`${a}-${i}`}>
          {a}
          {i < addrs.length - 1 ? (
            <span className="text-[var(--color-muted-foreground)]">, </span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

function AuthPanel({ auth }: { auth: MessagePayload['auth'] }) {
  const has = auth && (auth.spf || auth.dkim || auth.dmarc || auth.remote_ip);
  if (!has) {
    return (
      <div className="rounded-md border border-dashed border-[var(--color-border)] p-3 text-xs text-[var(--color-muted-foreground)]">
        No authentication results recorded.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
      <AuthCell label="SPF" value={auth?.spf} />
      <AuthCell label="DKIM" value={auth?.dkim} />
      <AuthCell label="DMARC" value={auth?.dmarc} />
      <div className="col-span-2 flex items-center gap-2 border-t border-[var(--color-border)] pt-2">
        <Globe className="h-3.5 w-3.5 text-[var(--color-muted-foreground)]" aria-hidden />
        <span className="text-[var(--color-muted-foreground)]">Remote IP</span>
        <span className="ml-auto font-mono">{auth?.remote_ip ?? '—'}</span>
      </div>
    </div>
  );
}

function AuthCell({ label, value }: { label: string; value: string | undefined }) {
  const variant = authBadgeVariant(value);
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[var(--color-muted-foreground)]">{label}</span>
      <Badge variant={variant} className="font-mono uppercase">
        {value ?? 'n/a'}
      </Badge>
    </div>
  );
}

// Lifecycle stage table — one row per recorded timestamp. The order is
// fixed by `buildLifecycle()` so the table reads top-to-bottom as the
// canonical pipeline order, even if some stages are skipped (failed
// jumps from `sending` straight to `failed`).
function LifecyclePanel({ message }: { message: MessagePayload }) {
  const stages = buildLifecycle(message).filter((s) => s.at);
  if (stages.length === 0) {
    return (
      <EmptyState
        title="No lifecycle timestamps yet"
        description="The message has not progressed past initial intake."
      />
    );
  }
  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[180px]">Stage</TableHead>
            <TableHead>Timestamp</TableHead>
            <TableHead className="w-[140px] text-right">Relative</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {stages.map((s) => (
            <TableRow key={s.key}>
              <TableCell className="text-sm font-medium">{s.label}</TableCell>
              <TableCell className="font-mono text-xs text-[var(--color-muted-foreground)]">
                {formatDate(s.at)}
              </TableCell>
              <TableCell className="text-right text-xs text-[var(--color-muted-foreground)]">
                {formatRelative(s.at)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {message.last_error ? (
        <div className="rounded-md border border-[var(--color-destructive)] bg-[color-mix(in_oklch,var(--color-destructive)_8%,var(--color-card))] p-3">
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-destructive)]">
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
            Last error
          </div>
          <pre className="font-mono text-xs whitespace-pre-wrap text-[var(--color-foreground)]">
            {message.last_error}
          </pre>
        </div>
      ) : null}
      {message.bounce_metadata ? (
        <Accordion type="single" collapsible>
          <AccordionItem value="bounce">
            <AccordionTrigger className="text-sm">Bounce metadata</AccordionTrigger>
            <AccordionContent>
              <pre className="overflow-auto rounded-md border bg-[color-mix(in_oklch,var(--color-muted)_50%,transparent)] p-3 font-mono text-xs">
                {typeof message.bounce_metadata === 'string'
                  ? message.bounce_metadata
                  : JSON.stringify(message.bounce_metadata, null, 2)}
              </pre>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      ) : null}
    </div>
  );
}

// Inline policy-decisions panel. For inbound the queue normally records
// exactly one row; we still iterate so a re-decided message surfaces the
// audit trail in the right order.
function PolicyPanel({ messageId, direction }: { messageId: string; direction: 'in' | 'out' }) {
  const q = useAdminQuery<{ data: PolicyDecisionRow[] }>(
    policyKeys.decisions({ message_id: messageId }),
    `/api/admin/policy/decisions?message_id=${encodeURIComponent(messageId)}`,
    { staleTime: 30_000 },
  );
  if (q.isLoading) return <Skeleton className="h-20 w-full" />;
  const rows = q.data?.data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No policy decisions"
        description={
          direction === 'in'
            ? 'Inbound message has not been scored by the policy engine.'
            : 'Outbound messages do not normally pass through the inbound policy engine.'
        }
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Verdict</TableHead>
          <TableHead>Score</TableHead>
          <TableHead>Top reasons</TableHead>
          <TableHead>LLM</TableHead>
          <TableHead className="text-right">Decided</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell>
              <StatusBadge kind="verdict" value={r.verdict} />
            </TableCell>
            <TableCell className="font-mono text-xs">{r.total_score}</TableCell>
            <TableCell className="font-mono text-xs text-[var(--color-muted-foreground)]">
              {summariseReasons(r.heuristic_reasons_json) || '—'}
            </TableCell>
            <TableCell className="font-mono text-xs">
              {r.llm_invoked
                ? `${r.llm_label ?? '—'} (${
                    r.llm_confidence != null ? r.llm_confidence.toFixed(2) : '—'
                  })`
                : '—'}
            </TableCell>
            <TableCell
              className="text-right text-xs text-[var(--color-muted-foreground)]"
              title={r.decided_at}
            >
              {formatRelative(r.decided_at)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// Inline DLQ panel with row-level "replay" / "drop" actions. We mirror
// the affordances on `/dlq` but keep them scoped to this message so the
// operator never has to context-switch.
function DlqPanel({ messageId }: { messageId: string }) {
  const q = useAdminQuery<{ data: DlqRow[] }>(
    [...dlqKeys.list(), 'by-message', messageId] as const,
    `/api/admin/webhook-dlq?message_id=${encodeURIComponent(messageId)}`,
    { staleTime: 30_000 },
  );
  const replay = useAdminMutation<unknown, { id: string }>(
    (vars) => ({ path: `/api/admin/webhook-dlq/${vars.id}/replay`, method: 'POST' }),
    {
      invalidateKeys: [dlqKeys.all, messageKeys.detail(messageId)],
      successMessage: 'Replay queued.',
    },
  );
  const drop = useAdminMutation<unknown, { id: string }>(
    (vars) => ({ path: `/api/admin/webhook-dlq/${vars.id}/drop`, method: 'POST' }),
    {
      invalidateKeys: [dlqKeys.all, messageKeys.detail(messageId)],
      successMessage: 'Dropped.',
    },
  );
  if (q.isLoading) return <Skeleton className="h-20 w-full" />;
  const rows = q.data?.data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No DLQ entries"
        description="No fanout deliveries for this message have failed permanently."
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Webhook</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Attempts</TableHead>
          <TableHead>Last error</TableHead>
          <TableHead className="text-right">DLQ&apos;d</TableHead>
          <TableHead className="w-[150px] text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell>
              <Link
                to="/webhook-subs/$id"
                params={{ id: r.webhook_sub_id }}
                className="font-mono text-xs underline-offset-2 hover:underline"
              >
                {r.webhook_sub_id.slice(0, 12)}…
              </Link>
            </TableCell>
            <TableCell className="font-mono text-xs">{r.last_status_code ?? '—'}</TableCell>
            <TableCell className="font-mono text-xs">{r.attempts}</TableCell>
            <TableCell
              className="max-w-[280px] truncate font-mono text-xs text-[var(--color-muted-foreground)]"
              title={r.last_error ?? ''}
            >
              {r.last_error ?? '—'}
            </TableCell>
            <TableCell
              className="text-right text-xs text-[var(--color-muted-foreground)]"
              title={r.dlq_at}
            >
              {formatRelative(r.dlq_at)}
            </TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => replay.mutate({ id: r.id })}
                  disabled={replay.isPending}
                  aria-label="Replay this DLQ entry"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Replay
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() => drop.mutate({ id: r.id })}
                  disabled={drop.isPending}
                  aria-label="Drop this DLQ entry"
                >
                  <Ban className="h-3.5 w-3.5" aria-hidden /> Drop
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ---------- main ----------

export function MessageDetail() {
  const { id } = useParams({ from: '/messages/$id' });
  const q = useAdminQuery<MessagePayload>(messageKeys.detail(id), `/api/messages/${id}`);

  // Side queries that drive the stat strip without forcing the strip
  // component itself to re-fetch (it has its own narrower hooks).
  const policyQ = useAdminQuery<{ data: PolicyDecisionRow[] }>(
    policyKeys.decisions({ message_id: id }),
    `/api/admin/policy/decisions?message_id=${encodeURIComponent(id)}`,
    { enabled: !!q.data && q.data.direction === 'in', staleTime: 30_000 },
  );
  const dlqQ = useAdminQuery<{ data: DlqRow[] }>(
    [...dlqKeys.list(), 'by-message', id] as const,
    `/api/admin/webhook-dlq?message_id=${encodeURIComponent(id)}`,
    { enabled: !!q.data, staleTime: 30_000 },
  );

  const breadcrumbs = useMemo(
    () => [{ label: 'Messages', to: '/messages' }, { label: q.data?.subject ?? id.slice(0, 12) }],
    [q.data?.subject, id],
  );

  if (q.isLoading) {
    return (
      <PageCard title="Message" breadcrumbs={breadcrumbs} decorative>
        <Skeleton className="h-48 w-full" />
      </PageCard>
    );
  }
  if (q.error || !q.data) {
    return (
      <PageCard title="Message" breadcrumbs={breadcrumbs} decorative>
        <ErrorText error={q.error ?? 'Not found.'} />
      </PageCard>
    );
  }
  const m = q.data;

  const textInline = m.text ?? m.bodies?.text?.inline;
  const htmlInline = m.html ?? m.bodies?.html?.inline;
  // Prefer the canonical `body_url`; fall back to per-mime bridge URLs.
  const bodyHref = m.body_url ?? m.bodies?.text?.url ?? m.bodies?.html?.url;
  // Default the content tab to whichever body has the most useful payload.
  const defaultTab: string = htmlInline ? 'html' : textInline ? 'text' : 'raw';
  const isOutbound = m.direction === 'out';
  const DirectionIcon = isOutbound ? Send : Inbox;
  const policyRow = policyQ.data?.data?.[0];
  const dlqCount = dlqQ.data?.data?.length ?? 0;

  // Outbound stat strip — "where in the send lifecycle did this land?"
  // Inbound stat strip — "did policy let it through, and did fanout fire?"
  const stats = isOutbound
    ? [
        {
          label: 'Queued',
          value: m.queued_at ? formatRelative(m.queued_at) : '—',
          title: m.queued_at,
        },
        { label: 'Sent', value: m.sent_at ? formatRelative(m.sent_at) : '—', title: m.sent_at },
        {
          label: 'Delivered',
          value: m.delivered_at ? formatRelative(m.delivered_at) : '—',
          title: m.delivered_at,
        },
        {
          label: 'Failed',
          value: m.failed_at ? formatRelative(m.failed_at) : '—',
          title: m.failed_at,
        },
      ]
    : [
        {
          label: 'Received',
          value: m.received_at_api
            ? formatRelative(m.received_at_api)
            : m.received_at_bridge
              ? formatRelative(m.received_at_bridge)
              : '—',
          title: m.received_at_api ?? m.received_at_bridge ?? '',
        },
        {
          label: 'Verdict',
          value: policyRow?.verdict ?? (policyQ.isLoading ? '…' : 'pending'),
          title: policyRow?.decided_at ?? '',
        },
        {
          label: 'Fanout',
          value: dlqCount > 0 ? `${dlqCount} in DLQ` : dlqQ.isLoading ? '…' : 'clean',
          title: dlqCount > 0 ? 'DLQ entries — see below' : 'No failed fanout deliveries',
        },
        {
          label: 'Body',
          value: formatBytes(m.body_bytes),
          title: `${m.attachments?.length ?? 0} attachments`,
        },
      ];

  // Header right-side action toolbar. Raw RFC822 is treated as the
  // primary download because it's the artefact T&S reviewers want.
  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      {bodyHref ? (
        <Button asChild size="sm" variant="outline">
          <a href={bodyHref} target="_blank" rel="noopener noreferrer">
            <FileText className="h-3.5 w-3.5" aria-hidden />
            <span>Raw RFC822</span>
            <ExternalLink className="h-3 w-3 opacity-60" aria-hidden />
          </a>
        </Button>
      ) : null}
      <CopyButton value={m.id} label="ID" />
      {m.header_message_id ? <CopyButton value={m.header_message_id} label="Message-ID" /> : null}
    </div>
  );

  // Title row — direction icon + subject. `created_at` is the only
  // timestamp the description carries; the rest live in the stat strip /
  // lifecycle panel so the description stays scannable.
  const title = (
    <span className="inline-flex items-center gap-2">
      <DirectionIcon className="h-5 w-5 text-[var(--color-muted-foreground)]" aria-hidden />
      <span>{m.subject ?? '(no subject)'}</span>
    </span>
  );
  const description = (
    <span className="inline-flex flex-wrap items-center gap-2">
      <StatusBadge kind="message" value={m.status} />
      <span className="text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">
        {m.direction === 'in' ? 'inbound' : 'outbound'}
      </span>
      {m.created_at ? (
        <>
          <span aria-hidden className="text-[var(--color-muted-foreground)]">
            ·
          </span>
          <span className="text-xs text-[var(--color-muted-foreground)]" title={m.created_at}>
            {formatRelative(m.created_at)}
          </span>
        </>
      ) : null}
      {m.from ? (
        <>
          <span aria-hidden className="text-[var(--color-muted-foreground)]">
            ·
          </span>
          <span className="font-mono text-xs">{m.from}</span>
        </>
      ) : null}
    </span>
  );

  return (
    <PageCard
      title={title}
      description={description}
      breadcrumbs={breadcrumbs}
      actions={actions}
      decorative
    >
      <div className="space-y-6">
        {/* Pipeline strip lives directly under the header — it answers
            "where is this in its lifecycle?" before the operator scans
            anything else on the page. */}
        <MessagePipelineStrip messageId={m.id} direction={m.direction} status={m.status} />

        {/* Stat strip — direction-specific scalar summary. Outbound
            shows the four lifecycle stages as relative timestamps;
            inbound shows received / verdict / fanout / body-size. */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {stats.map((s) => (
            <StatTile
              key={s.label}
              label={s.label}
              value={s.value}
              mono
              title={s.title || undefined}
            />
          ))}
        </div>

        {/* Main two-column body. Content on the left (HTML/Text/Raw
            tabs), metadata + auth sidebar on the right. On mobile both
            collapse to a single column. */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section aria-label="Message content" className="min-w-0 space-y-3">
            <Tabs defaultValue={defaultTab}>
              <TabsList>
                <TabsTrigger value="html" disabled={!htmlInline}>
                  <Mail className="h-3.5 w-3.5" aria-hidden /> HTML
                </TabsTrigger>
                <TabsTrigger value="text" disabled={!textInline}>
                  <FileText className="h-3.5 w-3.5" aria-hidden /> Text
                </TabsTrigger>
                <TabsTrigger value="raw">
                  <Code className="h-3.5 w-3.5" aria-hidden /> Source
                </TabsTrigger>
              </TabsList>
              <TabsContent value="html" className="mt-3">
                {htmlInline ? (
                  <iframe
                    title="html body"
                    srcDoc={htmlInline}
                    className="h-[420px] w-full rounded-md border border-[var(--color-border)] bg-[var(--color-card)]"
                    sandbox=""
                  />
                ) : (
                  <EmptyState
                    title="No HTML body"
                    description="This message did not include a `text/html` part."
                  />
                )}
              </TabsContent>
              <TabsContent value="text" className="mt-3">
                {textInline ? (
                  <pre className="max-h-[420px] overflow-auto rounded-md border border-[var(--color-border)] bg-[color-mix(in_oklch,var(--color-muted)_40%,transparent)] p-3 text-sm whitespace-pre-wrap">
                    {textInline}
                  </pre>
                ) : (
                  <EmptyState
                    title="No text body"
                    description="This message did not include a `text/plain` part."
                  />
                )}
              </TabsContent>
              <TabsContent value="raw" className="mt-3">
                <div className="space-y-3">
                  {bodyHref ? (
                    <Button asChild size="sm" variant="outline">
                      <a href={bodyHref} target="_blank" rel="noopener noreferrer">
                        <FileText className="h-3.5 w-3.5" aria-hidden />
                        Download raw RFC822
                        <ExternalLink className="h-3 w-3 opacity-60" aria-hidden />
                      </a>
                    </Button>
                  ) : null}
                  <div>
                    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
                      Headers
                    </h3>
                    {m.headers && Object.keys(m.headers).length > 0 ? (
                      <pre className="max-h-[280px] overflow-auto rounded-md border border-[var(--color-border)] bg-[color-mix(in_oklch,var(--color-muted)_40%,transparent)] p-3 text-xs">
                        {Object.entries(m.headers)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join('\n')}
                      </pre>
                    ) : (
                      <p className="text-xs text-[var(--color-muted-foreground)]">
                        No headers captured.
                      </p>
                    )}
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          </section>

          <aside
            aria-label="Message metadata"
            className="space-y-4 lg:sticky lg:top-4 lg:self-start"
          >
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-4">
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
                <Server className="h-3.5 w-3.5" aria-hidden /> Envelope
              </h3>
              <MetaList>
                <MetaRow label="From">
                  <span className="font-mono text-xs">{m.from}</span>
                </MetaRow>
                <MetaRow label="To">
                  <AddressList addrs={m.to} />
                </MetaRow>
                {m.cc && m.cc.length > 0 ? (
                  <MetaRow label="Cc">
                    <AddressList addrs={m.cc} />
                  </MetaRow>
                ) : null}
                {m.bcc && m.bcc.length > 0 ? (
                  <MetaRow label="Bcc">
                    <AddressList addrs={m.bcc} />
                  </MetaRow>
                ) : null}
                {m.mailbox_id ? (
                  <MetaRow label="Mailbox">
                    <Link
                      to="/mailboxes/$id"
                      params={{ id: m.mailbox_id }}
                      className="font-mono text-xs underline-offset-2 hover:underline"
                    >
                      {m.mailbox_id}
                    </Link>
                  </MetaRow>
                ) : null}
                {m.thread_id ? (
                  <MetaRow label="Thread">
                    <span className="font-mono text-xs">{m.thread_id}</span>
                  </MetaRow>
                ) : null}
                {m.header_message_id ? (
                  <MetaRow label="Message-ID">
                    <span className="font-mono text-xs break-all">{m.header_message_id}</span>
                  </MetaRow>
                ) : null}
                <MetaRow label="ID">
                  <span className="font-mono text-xs break-all">{m.id}</span>
                </MetaRow>
              </MetaList>
            </div>

            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-4">
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
                {m.auth?.spf === 'pass' && m.auth?.dkim === 'pass' && m.auth?.dmarc === 'pass' ? (
                  <ShieldCheck className="h-3.5 w-3.5 text-[var(--color-success)]" aria-hidden />
                ) : (
                  <Shield className="h-3.5 w-3.5" aria-hidden />
                )}
                Authentication
              </h3>
              <AuthPanel auth={m.auth} />
            </div>
          </aside>
        </div>

        {/* Lifecycle table — every recorded stage timestamp + last_error
            + bounce metadata. Equally useful for outbound retry debug
            and inbound provenance audits. */}
        <section aria-label="Lifecycle" className="space-y-2">
          <h2 className="text-base font-semibold">Lifecycle</h2>
          <LifecyclePanel message={m} />
        </section>

        {/* Inbound policy decisions — full verdict rows, not a tile. */}
        {m.direction === 'in' ? (
          <section aria-label="Policy decisions" className="space-y-2">
            <h2 className="text-base font-semibold">Policy decisions</h2>
            <PolicyPanel messageId={m.id} direction={m.direction} />
          </section>
        ) : null}

        {/* DLQ rows — surfaced for both directions: outbound messages can
            still have webhook-fanout failures (delivered → message.sent
            event fans out to subscribers). */}
        <section aria-label="Fanout DLQ" className="space-y-2">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            Fanout DLQ
            {dlqCount > 0 ? <Badge variant="destructive">{dlqCount}</Badge> : null}
          </h2>
          <DlqPanel messageId={m.id} />
        </section>

        {/* Attachments — last on the page because they're a
            click-through artefact, not part of the reviewer's
            scanning path. */}
        <section aria-label="Attachments" className="space-y-2">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Paperclip className="h-4 w-4" aria-hidden />
            Attachments
            {m.attachments && m.attachments.length > 0 ? (
              <Badge variant="secondary">{m.attachments.length}</Badge>
            ) : null}
          </h2>
          {(m.attachments ?? []).length === 0 ? (
            <EmptyState title="No attachments" description="This message has no attached parts." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[40px]">#</TableHead>
                  <TableHead>Filename</TableHead>
                  <TableHead>Content-Type</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="w-[140px] text-right"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(m.attachments ?? []).map((a, i) => (
                  <TableRow key={`${a.filename}:${i}`}>
                    <TableCell className="font-mono text-xs">{i}</TableCell>
                    <TableCell className="font-medium">{a.filename}</TableCell>
                    <TableCell className="font-mono text-xs text-[var(--color-muted-foreground)]">
                      {a.content_type}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatBytes(a.size_bytes ?? a.bytes)}
                    </TableCell>
                    <TableCell className="text-right">
                      {a.url ? (
                        <Button asChild size="sm" variant="outline">
                          <a href={a.url} target="_blank" rel="noopener noreferrer">
                            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                            Download
                          </a>
                        </Button>
                      ) : (
                        <span className="text-xs text-[var(--color-muted-foreground)]">No URL</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      </div>
    </PageCard>
  );
}
