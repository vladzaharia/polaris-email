/*
 * Mailbox detail — redesigned (mailbox-as-source-of-truth Stage 4).
 *
 * What was wrong with the previous incarnation:
 *   - Five equal-weight stacked sections (Senders → Receivers → Credentials
 *     → Webhooks → split Recent sent/Recent received) forced every operator
 *     to scroll past four tables they didn't need before reaching theirs.
 *     A reviewer auditing throughput, a developer debugging a stale token,
 *     and an SRE chasing a DLQ alert all had to navigate the same wall.
 *   - The recent-messages panel referenced `from_addr` / `to_addrs`, which
 *     the API never returns — the unified-message envelope is `from` /
 *     `to: string[]`. Every row silently rendered "—" for the address.
 *   - The mailbox's own enable/disable state was never surfaced; there
 *     was no rename, no enable-mailbox action, and no way to spot a
 *     never-used credential at a glance.
 *
 * What this design optimises for:
 *   - A persistent header that answers "what is this mailbox" — name,
 *     status, default sender, created — plus the three high-value actions
 *     (Send test, Add credential, Disable mailbox) the audiences above all
 *     reach for first.
 *   - A 24h stats strip derived from the last 50 messages so the "is this
 *     thing flowing?" answer is one glance, never a click.
 *   - Tabs to focus the body: Overview (at-a-glance + stale-credential
 *     callout), Routing (Senders + Receivers — they cross-reference),
 *     Credentials, Webhooks (with DLQ cross-link), Activity (direction
 *     filter + terminal-status row highlight, and the from/to bug fixed).
 *   - Tabs deep-link via `?tab=...` so an alert can drop the operator
 *     straight into Webhooks or Activity.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useNavigate, useSearch } from '@tanstack/react-router';
import {
  AlertTriangle,
  Inbox,
  KeyRound,
  Plus,
  Send,
  ShieldCheck,
  Webhook as WebhookIcon,
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
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Switch } from '../../components/ui/switch.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../components/ui/dialog.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { Badge } from '../../components/ui/badge.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { DestructiveActionDialog } from '../../components/DestructiveActionDialog.js';
import { ErrorText } from '../../components/ErrorText.js';
import { EmptyState } from '../../components/EmptyState.js';
import { StatTile } from '../../components/StatTile.js';
import { MetaList, MetaRow } from '../../components/MetaList.js';
import { SegmentedControl } from '../../components/SegmentedControl.js';
import { CompositeInput } from '../../components/CompositeInput.js';
import { SuggestionChip, SuggestionChipRow } from '../../components/SuggestionChip.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { domainKeys, mailboxKeys, webhookKeys } from '../../queryKeys.js';
import { formatDate, formatRelative } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import { IssueCredentialDialog } from '../credentials/IssueCredentialDialog.js';
import { CreateWebhookSubDialog } from '../webhook-subs/CreateWebhookSubDialog.js';
import { SendTestDialog } from '../test-send/SendTestDialog.js';

// ---------- payload shapes ----------

interface CredentialRow {
  id: string;
  mailbox_id: string;
  type: 'imap' | 'smtp' | 'rest' | 'mcp' | 'cli';
  prefix: string;
  receiver_id: string | null;
  display_name: string | null;
  status: 'primary' | 'secondary' | 'revoked';
  rate_limit_per_min: number;
  created_at: string;
  last_used_at: string | null;
  last_used_ip: string | null;
  disabled_at: string | null;
  revoked_at: string | null;
}

// The credential identity an operator types into an IMAP/SMTP client
// (and what the REST/CLI/MCP variants pass in `X-Polaris-Key-Id`) is
// `<prefix><id>` — same shape across all types.
function credentialIdentity(c: CredentialRow): string {
  return `${c.prefix}${c.id}`;
}

interface SenderRow {
  id: string;
  address: string;
  domain_id: string;
  default_for_mailbox: number;
  disabled_at: string | null;
}

interface ReceiverRow {
  id: string;
  domain_id: string;
  priority: number;
  address_pattern: string;
  action: string;
  enabled: number;
}

interface WebhookSubRow {
  id: string;
  url: string;
  kind: string;
  events: string;
  paused_at: string | null;
  disabled_at: string | null;
}

interface MailboxDetailPayload {
  mailbox: {
    id: string;
    name: string;
    description: string | null;
    created_at: string;
    disabled_at: string | null;
    default_sender_id?: string | null;
  };
  senders: SenderRow[];
  receivers: ReceiverRow[];
  principals: Array<{ id: string; kind: string; display_name: string | null }>;
  webhook_subs: WebhookSubRow[];
  credentials: CredentialRow[];
}

interface DomainRow {
  id: string;
  name: string;
}

/**
 * `/api/messages` response row. The unified-message envelope is `from` plus
 * `to: string[]` — the previous Detail incarnation read non-existent
 * `from_addr` / `to_addrs` fields and rendered "—" for every row.
 */
interface RecentMessageRow {
  id: string;
  direction: 'in' | 'out';
  subject?: string;
  status: string;
  from: string;
  to?: string[];
  created_at: string;
}

interface DlqRow {
  id: string;
  webhook_sub_id: string;
}

// Tabs persisted to `?tab=...`. Default is `overview`; the alert routes
// (`?tab=webhooks` from a DLQ alert, `?tab=activity` from "investigate")
// land directly on the right surface.
const TAB_VALUES = ['overview', 'routing', 'credentials', 'webhooks', 'activity'] as const;
type TabValue = (typeof TAB_VALUES)[number];

// Suggested local-part chips for Add Sender. These cover ~90% of operator
// intent (transactional bounces, support inbox, generic noreply); operators
// can still type a freeform local-part for anything else.
const SENDER_LOCAL_PART_SUGGESTIONS = ['noreply', 'support', 'transactional', 'bounces'];

// Suggested receive patterns. `*` (catch-all) is overwhelmingly the most
// common; specific local-parts (`support`, `webhook`) come up for routing
// a single address to a different downstream.
const RECEIVER_PATTERN_SUGGESTIONS = ['*', 'support', 'webhook', 'unsubscribe'];

// A credential that hasn't been used in >90d is a stale-secret risk. We
// surface this on the Overview tab as a callout.
const STALE_CREDENTIAL_MS = 90 * 24 * 60 * 60 * 1000;

// ---------- inline Add dialogs (kept verbatim — composite-input UX is good) ----------

function AddSenderDialog({ mailboxId }: { mailboxId: string }) {
  const [open, setOpen] = useState(false);
  const [domainId, setDomainId] = useState('');
  const [localPart, setLocalPart] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const domains = useAdminQuery<{ data: DomainRow[] }>(domainKeys.list(), '/api/admin/domains');
  const domainRows = domains.data?.data ?? [];

  // Default to the first available domain so single-domain mailboxes never
  // make the operator click into the dropdown. Depend on the first id (a
  // stable string) rather than the array (re-allocated every render via ??[]).
  const firstDomainId = domains.data?.data[0]?.id;
  useEffect(() => {
    if (!domainId && firstDomainId) {
      setDomainId(firstDomainId);
    }
  }, [domainId, firstDomainId]);

  const selectedDomain = domainRows.find((d) => d.id === domainId);

  const create = useAdminMutation<unknown, Record<string, unknown>>(
    (vars) => ({
      path: `/api/admin/mailboxes/${mailboxId}/senders`,
      method: 'POST',
      body: vars,
    }),
    { invalidateKeys: [mailboxKeys.detail(mailboxId)] },
  );
  const reset = () => {
    setLocalPart('');
    setIsDefault(false);
    create.reset();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add sender
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add sender</DialogTitle>
          <DialogDescription>
            Compose an outbound From-address as <code className="font-mono">local-part@domain</code>
            .
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Address</Label>
            <CompositeInput
              leftValue={localPart}
              onLeftChange={setLocalPart}
              leftPlaceholder="noreply"
              separator="@"
              rightValue={domainId}
              onRightChange={setDomainId}
              rightOptions={domainRows.map((d) => ({ value: d.id, label: d.name }))}
              rightLoading={domains.isLoading}
              rightLoadingPlaceholder="Loading domains…"
              rightPlaceholder="Pick a domain"
              previewLabel={selectedDomain ? 'Will register' : undefined}
              preview={
                selectedDomain ? (localPart || 'noreply') + '@' + selectedDomain.name : undefined
              }
            />
            <SuggestionChipRow>
              {SENDER_LOCAL_PART_SUGGESTIONS.map((s) => (
                <SuggestionChip key={s} onSelect={() => setLocalPart(s)} active={localPart === s}>
                  {s}
                </SuggestionChip>
              ))}
            </SuggestionChipRow>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={isDefault} onCheckedChange={setIsDefault} id="def" />
            <Label htmlFor="def">Default sender for this mailbox</Label>
          </div>
          <ErrorText error={create.error} />
        </div>
        <DialogFooter>
          <Button
            onClick={async () => {
              await create.mutateAsync({
                domain_id: domainId,
                local_part: localPart.trim(),
                default_for_mailbox: isDefault,
              });
              setOpen(false);
              reset();
            }}
            disabled={!domainId || !localPart.trim() || create.isPending}
          >
            {create.isPending ? 'Adding…' : 'Add sender'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddReceiverDialog({ mailboxId }: { mailboxId: string }) {
  const [open, setOpen] = useState(false);
  const [domainId, setDomainId] = useState('');
  const [priority, setPriority] = useState(100);
  const [pattern, setPattern] = useState('*');
  const [action, setAction] = useState<'webhook' | 'forward' | 'drop'>('webhook');
  const [webhookSubId, setWebhookSubId] = useState('');
  const [forwardTo, setForwardTo] = useState('');
  const domains = useAdminQuery<{ data: DomainRow[] }>(domainKeys.list(), '/api/admin/domains');
  const domainRows = domains.data?.data ?? [];
  const subs = useAdminQuery<{ data: { id: string; url: string }[] }>(
    webhookKeys.list(mailboxId),
    `/api/admin/webhook-subs?mailbox_id=${mailboxId}`,
  );

  // Default to the first domain like Add Sender does, so single-domain
  // mailboxes never make the operator click into the dropdown. Same
  // stable-dep trick — first id is a string, the array isn't.
  const firstDomainId = domains.data?.data[0]?.id;
  useEffect(() => {
    if (!domainId && firstDomainId) {
      setDomainId(firstDomainId);
    }
  }, [domainId, firstDomainId]);

  const selectedDomain = domainRows.find((d) => d.id === domainId);

  const create = useAdminMutation<unknown, Record<string, unknown>>(
    (vars) => ({
      path: `/api/admin/mailboxes/${mailboxId}/receivers`,
      method: 'POST',
      body: vars,
    }),
    { invalidateKeys: [mailboxKeys.detail(mailboxId)] },
  );
  const reset = () => {
    setPriority(100);
    setPattern('*');
    setAction('webhook');
    setWebhookSubId('');
    setForwardTo('');
    create.reset();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add receiver
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add receiver</DialogTitle>
          <DialogDescription>
            Match inbound mail to <code className="font-mono">pattern@domain</code> and pick what
            happens — fan out to a webhook, forward to another address, or drop.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Match pattern</Label>
            <CompositeInput
              leftValue={pattern}
              onLeftChange={setPattern}
              leftPlaceholder="* or local-part"
              separator="@"
              rightValue={domainId}
              onRightChange={setDomainId}
              rightOptions={domainRows.map((d) => ({ value: d.id, label: d.name }))}
              rightLoading={domains.isLoading}
              rightLoadingPlaceholder="Loading domains…"
              rightPlaceholder="Pick a domain"
              previewLabel={selectedDomain ? 'Will match' : undefined}
              preview={selectedDomain ? (pattern || '*') + '@' + selectedDomain.name : undefined}
              previewNote={
                selectedDomain ? (
                  <span className="italic">{pattern === '*' ? 'catch-all' : 'exact'}</span>
                ) : undefined
              }
            />
            <SuggestionChipRow>
              {RECEIVER_PATTERN_SUGGESTIONS.map((s) => (
                <SuggestionChip key={s} onSelect={() => setPattern(s)} active={pattern === s}>
                  {s}
                </SuggestionChip>
              ))}
            </SuggestionChipRow>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="prio">Priority</Label>
              <Input
                id="prio"
                type="number"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
              />
              <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">Lower runs first.</p>
            </div>
            <div>
              <Label>Action</Label>
              <Select
                value={action}
                onValueChange={(v) => setAction(v as 'webhook' | 'forward' | 'drop')}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="webhook">Webhook</SelectItem>
                  <SelectItem value="forward">Forward</SelectItem>
                  <SelectItem value="drop">Drop</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {action === 'webhook' ? (
            <div>
              <Label>Deliver to webhook subscription</Label>
              <Select value={webhookSubId || undefined} onValueChange={setWebhookSubId}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Pick a webhook subscription" />
                </SelectTrigger>
                <SelectContent>
                  {(subs.data?.data ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.url}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(subs.data?.data ?? []).length === 0 ? (
                <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                  No webhook subscriptions yet — add one in the Webhooks tab first.
                </p>
              ) : null}
            </div>
          ) : null}
          {action === 'forward' ? (
            <div>
              <Label htmlFor="fwd">Forward to address</Label>
              <Input
                id="fwd"
                type="email"
                value={forwardTo}
                onChange={(e) => setForwardTo(e.target.value)}
                placeholder="ops@example.com"
              />
            </div>
          ) : null}
          <ErrorText error={create.error} />
        </div>
        <DialogFooter>
          <Button
            disabled={!domainId || !pattern || create.isPending}
            onClick={async () => {
              await create.mutateAsync({
                domain_id: domainId,
                priority,
                address_pattern: pattern,
                action,
                webhook_sub_id: action === 'webhook' ? webhookSubId : null,
                forward_to: action === 'forward' ? forwardTo : null,
              });
              setOpen(false);
            }}
          >
            {create.isPending ? 'Adding…' : 'Add receiver'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- helpers ----------

/**
 * Quick rollup of the last 50 sent rows so the header strip can answer the
 * "is this mailbox flowing?" question without a dedicated per-mailbox stats
 * endpoint. Status set comes from `statusBadge('message', …)` —
 * `delivered`/`failed`/`bounced` are the terminal states the audiences care
 * about; anything else lumps under `inflight`.
 */
function rollupSent(rows: RecentMessageRow[]): {
  sent: number;
  delivered: number;
  failed: number;
  bounced: number;
  inflight: number;
} {
  const out = { sent: 0, delivered: 0, failed: 0, bounced: 0, inflight: 0 };
  for (const r of rows) {
    out.sent++;
    if (r.status === 'delivered') out.delivered++;
    else if (r.status === 'failed') out.failed++;
    else if (r.status === 'bounced') out.bounced++;
    else if (r.status === 'queued' || r.status === 'sending' || r.status === 'sent') out.inflight++;
  }
  return out;
}

/**
 * A "stale" credential is one that has never been used, OR whose
 * `last_used_at` is more than 90 days old. We surface the count on the
 * Overview tab so an auditor can spot dormant secrets without scrolling
 * through the table.
 */
function isStaleCredential(c: CredentialRow, now: number): boolean {
  if (c.disabled_at) return false;
  if (!c.last_used_at) return true;
  return now - new Date(c.last_used_at).getTime() > STALE_CREDENTIAL_MS;
}

/**
 * "How long has this row been disabled / unused?" — small inline relative
 * timestamp with the absolute value as the tooltip. Used in several tables
 * where space is tight.
 */
function When({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span className="text-[var(--color-muted-foreground)]">—</span>;
  return (
    <span className="text-xs text-[var(--color-muted-foreground)]" title={formatDate(iso)}>
      {formatRelative(iso)}
    </span>
  );
}

// ---------- recent-activity table (shared by Overview and Activity tabs) ----------

function ActivityTable({
  rows,
  loading,
  emptyMessage,
}: {
  rows: RecentMessageRow[];
  loading: boolean;
  emptyMessage: string;
}) {
  if (loading) return <Skeleton className="h-32 w-full" />;
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No activity"
        description={emptyMessage}
        icon={<Inbox className="h-5 w-5" aria-hidden />}
      />
    );
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[120px]">When</TableHead>
            <TableHead className="w-[80px]">Dir</TableHead>
            <TableHead>Subject</TableHead>
            <TableHead>From / To</TableHead>
            <TableHead className="w-[110px]">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((m) => {
            const terminal = m.status === 'failed' || m.status === 'bounced';
            return (
              <TableRow
                key={m.id}
                className={cn(
                  'text-sm',
                  terminal ? 'border-l-2 border-l-[var(--color-destructive)]' : null,
                )}
              >
                <TableCell
                  className="whitespace-nowrap text-xs text-[var(--color-muted-foreground)]"
                  title={formatDate(m.created_at)}
                >
                  {formatRelative(m.created_at)}
                </TableCell>
                <TableCell>
                  <StatusBadge kind="direction" value={m.direction} />
                </TableCell>
                <TableCell className="max-w-xs truncate text-sm">
                  <Link
                    to="/messages/$id"
                    params={{ id: m.id }}
                    className="font-medium hover:underline"
                  >
                    {m.subject ? (
                      m.subject
                    ) : (
                      <span className="italic text-[var(--color-muted-foreground)]">
                        (no subject)
                      </span>
                    )}
                  </Link>
                </TableCell>
                <TableCell
                  className="max-w-xs truncate font-mono text-xs text-[var(--color-muted-foreground)]"
                  title={m.direction === 'out' ? (m.to ?? []).join(', ') : m.from}
                >
                  {m.direction === 'out' ? (m.to ?? []).join(', ') || '—' : m.from || '—'}
                </TableCell>
                <TableCell>
                  <StatusBadge kind="message" value={m.status} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------- main page ----------

interface MailboxSearch {
  tab?: TabValue;
}

function isTab(v: unknown): v is TabValue {
  return typeof v === 'string' && (TAB_VALUES as readonly string[]).includes(v);
}

export function MailboxDetail() {
  const { id } = useParams({ from: '/mailboxes/$id' });
  const navigate = useNavigate();
  // The mailbox route doesn't validateSearch (yet), so we read defensively
  // and accept anything that matches our enum. Anything else falls back to
  // `overview`. Deep links from alerts (e.g. `?tab=webhooks`) still work.
  const search = useSearch({ strict: false }) as MailboxSearch;
  const activeTab: TabValue = isTab(search.tab) ? search.tab : 'overview';
  const setTab = (next: TabValue) => {
    void navigate({
      to: '/mailboxes/$id',
      params: { id },
      search: { tab: next === 'overview' ? undefined : next },
      replace: true,
    });
  };

  const q = useAdminQuery<MailboxDetailPayload>(
    mailboxKeys.detail(id),
    `/api/admin/mailboxes/${id}`,
  );
  // Larger limits (50) so the Overview stats rollup is meaningful and the
  // Activity tab has enough scrollback for incident triage. Two requests so
  // each direction has its own freshness window.
  const recentSent = useAdminQuery<{ data: RecentMessageRow[] }>(
    mailboxKeys.recentMessages(id, 'out'),
    `/api/messages?mailbox_id=${id}&direction=out&limit=50`,
    { staleTime: 15_000 },
  );
  const recentReceived = useAdminQuery<{ data: RecentMessageRow[] }>(
    mailboxKeys.recentMessages(id, 'in'),
    `/api/messages?mailbox_id=${id}&direction=in&limit=50`,
    { staleTime: 15_000 },
  );
  // DLQ cross-link — count entries belonging to this mailbox's webhook subs.
  // The DLQ list is small enough (<200) that a global query + client filter
  // is cheaper than fanning out per-sub.
  const dlq = useAdminQuery<{ data: DlqRow[] }>(
    ['webhook-dlq', 'mailbox', id],
    `/api/admin/webhook-dlq`,
    {
      staleTime: 30_000,
    },
  );
  const domains = useAdminQuery<{ data: DomainRow[] }>(domainKeys.list(), '/api/admin/domains', {
    staleTime: 60_000,
  });

  // ---------- mutations ----------
  const disableSender = useAdminMutation<unknown, { senderId: string }>(
    (vars) => ({
      path: `/api/admin/mailboxes/${id}/senders/${vars.senderId}`,
      method: 'DELETE',
    }),
    { invalidateKeys: [mailboxKeys.detail(id)], successMessage: 'Sender disabled.' },
  );
  const disableReceiver = useAdminMutation<unknown, { receiverId: string }>(
    (vars) => ({
      path: `/api/admin/mailboxes/${id}/receivers/${vars.receiverId}`,
      method: 'DELETE',
    }),
    { invalidateKeys: [mailboxKeys.detail(id)], successMessage: 'Receiver disabled.' },
  );
  const disableCredential = useAdminMutation<unknown, { credId: string }>(
    (vars) => ({
      path: `/api/admin/mailboxes/${id}/credentials/${vars.credId}`,
      method: 'DELETE',
    }),
    { invalidateKeys: [mailboxKeys.detail(id)], successMessage: 'Credential disabled.' },
  );
  const pauseWebhookSub = useAdminMutation<unknown, { subId: string; pause: boolean }>(
    (vars) => ({
      path: `/api/admin/webhook-subs/${vars.subId}`,
      method: 'PATCH',
      body: { paused: vars.pause },
    }),
    {
      invalidateKeys: [mailboxKeys.detail(id)],
      successMessage: 'Webhook subscription updated.',
    },
  );
  const deleteWebhookSub = useAdminMutation<unknown, { subId: string }>(
    (vars) => ({
      path: `/api/admin/webhook-subs/${vars.subId}`,
      method: 'DELETE',
    }),
    { invalidateKeys: [mailboxKeys.detail(id)], successMessage: 'Webhook subscription removed.' },
  );
  const setMailboxDisabled = useAdminMutation<unknown, { disable: boolean }>(
    (vars) => ({
      path: `/api/admin/mailboxes/${id}/${vars.disable ? 'disable' : 'enable'}`,
      method: 'POST',
    }),
    {
      invalidateKeys: [mailboxKeys.detail(id), mailboxKeys.list()],
      successMessage: 'Mailbox state updated.',
    },
  );

  // ---------- destructive-action confirm targets ----------
  const [confirmDisableSender, setConfirmDisableSender] = useState<{
    id: string;
    address: string;
  } | null>(null);
  const [confirmDisableReceiver, setConfirmDisableReceiver] = useState<{
    id: string;
    pattern: string;
  } | null>(null);
  const [confirmDisableCredential, setConfirmDisableCredential] = useState<{
    id: string;
    identity: string;
  } | null>(null);
  const [confirmDeleteWebhook, setConfirmDeleteWebhook] = useState<{
    id: string;
    url: string;
  } | null>(null);
  const [confirmDisableMailbox, setConfirmDisableMailbox] = useState(false);

  // ---------- activity filter (Activity tab only) ----------
  const [activityDir, setActivityDir] = useState<'all' | 'out' | 'in'>('all');

  // Recent message feeds — read above the early returns so the
  // useMemoMerge() hook below is called on every render, not just the
  // loaded one. (React enforces stable hook order; calling useMemoMerge
  // only when q.data resolves trips error #310 the moment the query
  // hydrates.)
  const sentRows = recentSent.data?.data ?? [];
  const receivedRows = recentReceived.data?.data ?? [];
  // Merged + sorted recent feed for the Overview "Latest activity" mini-table.
  const mixedRecent: RecentMessageRow[] = useMemoMerge(sentRows, receivedRows);

  const breadcrumbs = [
    { label: 'Mailboxes', to: '/mailboxes' },
    { label: q.data?.mailbox.name ?? id },
  ];

  // ---------- loading / error ----------
  if (q.isLoading) {
    return (
      <PageCard title="Mailbox" breadcrumbs={breadcrumbs} decorative>
        <Skeleton className="h-32 w-full" />
      </PageCard>
    );
  }
  if (q.error || !q.data) {
    return (
      <PageCard title="Mailbox" breadcrumbs={breadcrumbs} decorative>
        <ErrorText error={q.error ?? 'Failed to load.'} />
      </PageCard>
    );
  }

  const d = q.data;
  const disabled = d.mailbox.disabled_at != null;
  const activeSenders = d.senders.filter((s) => !s.disabled_at);
  const activeReceivers = d.receivers.filter((r) => r.enabled);
  const activeCredentials = d.credentials.filter((c) => !c.disabled_at);
  const activeWebhooks = d.webhook_subs.filter((w) => !w.disabled_at);
  const pausedWebhooks = activeWebhooks.filter((w) => w.paused_at);
  const defaultSender = d.senders.find((s) => s.default_for_mailbox && !s.disabled_at);

  // Cross-references: domains used by senders, DLQ entries for our subs.
  const domainNameById = new Map((domains.data?.data ?? []).map((dr) => [dr.id, dr.name]));
  const subIds = new Set(d.webhook_subs.map((w) => w.id));
  const dlqForMailbox = (dlq.data?.data ?? []).filter((row) => subIds.has(row.webhook_sub_id));

  // Rolled-up stats from the last 50 sent rows. Drives the header strip; we
  // don't hit a separate per-mailbox stats endpoint because there isn't one.
  // (sentRows/receivedRows are hoisted above the early returns so the
  // useMemoMerge() hook stays in stable order — see above.)
  const rollup = rollupSent(sentRows);
  const lastSentAt = sentRows[0]?.created_at ?? null;
  const lastReceivedAt = receivedRows[0]?.created_at ?? null;

  // Stale-credential watchlist — surfaced on Overview.
  const now = Date.now();
  const staleCredentials = activeCredentials.filter((c) => isStaleCredential(c, now));

  const headerActions = (
    <>
      <SendTestDialog mailboxId={id} senders={activeSenders} />
      <IssueCredentialDialog mailboxId={id} />
      <Button
        size="sm"
        variant={disabled ? 'outline' : 'outline'}
        onClick={() => {
          if (disabled) {
            void setMailboxDisabled.mutateAsync({ disable: false });
          } else {
            setConfirmDisableMailbox(true);
          }
        }}
        disabled={setMailboxDisabled.isPending}
      >
        {disabled ? 'Enable mailbox' : 'Disable mailbox'}
      </Button>
    </>
  );

  return (
    <PageCard
      decorative
      breadcrumbs={breadcrumbs}
      title={
        <span className="inline-flex items-center gap-2">
          {d.mailbox.name}
          <StatusBadge kind="enabled" value={disabled ? 'disabled' : 'active'} />
        </span>
      }
      description={d.mailbox.description ?? 'No description.'}
      actions={headerActions}
    >
      <div className="space-y-6">
        {/* ---------- identity / metadata strip ----------
            Two-column layout: definition list on the left (id, default
            sender, created), stats tiles on the right. Keeps the "what is
            this" answer on the same row as the "how is it doing" answer. */}
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
          <div
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-4"
            style={{
              background: 'color-mix(in oklch, var(--color-card) 96%, var(--color-primary) 4%)',
            }}
          >
            <MetaList>
              <MetaRow label="Mailbox id">
                <code className="font-mono text-xs break-all">{d.mailbox.id}</code>
              </MetaRow>
              <MetaRow label="Default sender">
                {defaultSender ? (
                  <code className="font-mono text-xs">{defaultSender.address}</code>
                ) : (
                  <span className="text-xs text-[var(--color-muted-foreground)]">
                    None — every send must specify an explicit From.
                  </span>
                )}
              </MetaRow>
              <MetaRow label="Principals">
                {d.principals.length > 0 ? (
                  <span>
                    {d.principals.length} attached
                    <span className="ml-1 text-xs text-[var(--color-muted-foreground)]">
                      ({d.principals.map((p) => p.kind).join(', ')})
                    </span>
                  </span>
                ) : (
                  <span className="text-xs text-[var(--color-muted-foreground)]">
                    No principals.
                  </span>
                )}
              </MetaRow>
              <MetaRow label="Created">
                <When iso={d.mailbox.created_at} />
              </MetaRow>
              {disabled ? (
                <MetaRow label="Disabled">
                  <When iso={d.mailbox.disabled_at} />
                </MetaRow>
              ) : null}
            </MetaList>
          </div>

          {/* Stats tiles — derived from the last 50 sent rows. The label
              `Last 50 sent` is honest about the window so an SRE doesn't
              confuse this with a 24h backend rollup. */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <StatTile label="Sent (last 50)" value={rollup.sent} />
            <StatTile label="Delivered" value={rollup.delivered} />
            <StatTile
              label="Failed + bounced"
              value={rollup.failed + rollup.bounced}
              className={
                rollup.failed + rollup.bounced > 0 ? 'border-[var(--color-destructive)]' : undefined
              }
            />
            <StatTile
              label="Last sent"
              value={lastSentAt ? formatRelative(lastSentAt) : '—'}
              mono={!lastSentAt}
              title={lastSentAt ? formatDate(lastSentAt) : undefined}
            />
            <StatTile
              label="Last received"
              value={lastReceivedAt ? formatRelative(lastReceivedAt) : '—'}
              mono={!lastReceivedAt}
              title={lastReceivedAt ? formatDate(lastReceivedAt) : undefined}
            />
            <StatTile
              label="In-flight"
              value={rollup.inflight}
              className={
                rollup.inflight > 0
                  ? 'border-[color-mix(in_oklch,var(--color-border)_60%,var(--color-info))]'
                  : undefined
              }
            />
          </div>
        </section>

        {/* ---------- tabs ----------
            `?tab=…` deep links — alerts can drop straight to Webhooks or
            Activity. The trigger row carries small badges that double as
            "what's in here" hints. */}
        <Tabs value={activeTab} onValueChange={(v) => setTab(v as TabValue)}>
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="routing">
              Routing
              <span className="ml-2 text-[var(--color-muted-foreground)]">
                {activeSenders.length}/{activeReceivers.length}
              </span>
            </TabsTrigger>
            <TabsTrigger value="credentials">
              Credentials
              <span className="ml-2 text-[var(--color-muted-foreground)]">
                {activeCredentials.length}
              </span>
              {staleCredentials.length > 0 ? (
                <AlertTriangle className="ml-1 h-3 w-3 text-[var(--color-warning)]" aria-hidden />
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="webhooks">
              Webhooks
              <span className="ml-2 text-[var(--color-muted-foreground)]">
                {activeWebhooks.length}
              </span>
              {dlqForMailbox.length > 0 ? (
                <AlertTriangle
                  className="ml-1 h-3 w-3 text-[var(--color-destructive)]"
                  aria-hidden
                />
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>

          {/* ---------- Overview ---------- */}
          <TabsContent value="overview">
            <div className="space-y-6">
              {/* Mini-cards: each links to its respective tab. Quicker than
                  picking the right tab when you arrived at this page from
                  an alert and you don't know which slice to read first. */}
              <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <OverviewMiniCard
                  icon={<Send className="h-4 w-4" aria-hidden />}
                  label="Senders"
                  primary={`${activeSenders.length} active`}
                  secondary={
                    d.senders.length - activeSenders.length > 0
                      ? `${d.senders.length - activeSenders.length} disabled`
                      : undefined
                  }
                  onOpen={() => setTab('routing')}
                />
                <OverviewMiniCard
                  icon={<Inbox className="h-4 w-4" aria-hidden />}
                  label="Receivers"
                  primary={`${activeReceivers.length} active`}
                  secondary={
                    d.receivers.length - activeReceivers.length > 0
                      ? `${d.receivers.length - activeReceivers.length} disabled`
                      : undefined
                  }
                  onOpen={() => setTab('routing')}
                />
                <OverviewMiniCard
                  icon={<KeyRound className="h-4 w-4" aria-hidden />}
                  label="Credentials"
                  primary={`${activeCredentials.length} active`}
                  secondary={
                    staleCredentials.length > 0 ? `${staleCredentials.length} stale` : undefined
                  }
                  warn={staleCredentials.length > 0}
                  onOpen={() => setTab('credentials')}
                />
                <OverviewMiniCard
                  icon={<WebhookIcon className="h-4 w-4" aria-hidden />}
                  label="Webhooks"
                  primary={`${activeWebhooks.length} active`}
                  secondary={
                    pausedWebhooks.length > 0
                      ? `${pausedWebhooks.length} paused`
                      : dlqForMailbox.length > 0
                        ? `${dlqForMailbox.length} in DLQ`
                        : undefined
                  }
                  warn={pausedWebhooks.length > 0 || dlqForMailbox.length > 0}
                  onOpen={() => setTab('webhooks')}
                />
              </section>

              {/* Stale-credential callout — only renders when there's
                  something to say, otherwise this is silent. */}
              {staleCredentials.length > 0 ? (
                <section
                  className="flex items-start gap-3 rounded-md border border-[var(--color-border)] p-4"
                  style={{
                    background:
                      'color-mix(in oklch, var(--color-card) 88%, var(--color-warning) 12%)',
                  }}
                >
                  <AlertTriangle
                    className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]"
                    aria-hidden
                  />
                  <div className="flex-1 text-sm">
                    <p className="font-medium">
                      {staleCredentials.length} credential
                      {staleCredentials.length === 1 ? '' : 's'} not used in 90+ days
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                      Stale secrets are a rotation candidate. Open the Credentials tab to disable or
                      rotate, or check whether the consumer service is still active.
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setTab('credentials')}>
                    Open
                  </Button>
                </section>
              ) : null}

              {/* Latest activity — mixed feed, 8 rows, sorted by time. The
                  full Activity tab is a click away for incident triage. */}
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-base font-semibold">Latest activity</h2>
                  <Button size="sm" variant="ghost" onClick={() => setTab('activity')}>
                    Open Activity →
                  </Button>
                </div>
                <ActivityTable
                  rows={mixedRecent.slice(0, 8)}
                  loading={recentSent.isLoading || recentReceived.isLoading}
                  emptyMessage="No messages have flowed through this mailbox yet. Send a test message from the header to verify routing."
                />
              </section>
            </div>
          </TabsContent>

          {/* ---------- Routing ---------- */}
          <TabsContent value="routing">
            <div className="space-y-6">
              <section>
                <header className="mb-3 flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-semibold">Senders</h2>
                    <p className="text-xs text-[var(--color-muted-foreground)]">
                      Outbound From-addresses this mailbox can send as.
                    </p>
                  </div>
                  <AddSenderDialog mailboxId={id} />
                </header>
                {d.senders.length === 0 ? (
                  <EmptyState
                    title="No senders yet"
                    description="Add one to enable outbound mail."
                    icon={<Send className="h-5 w-5" aria-hidden />}
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Address</TableHead>
                          <TableHead>Domain</TableHead>
                          <TableHead className="w-[90px]">Default</TableHead>
                          <TableHead className="w-[100px]">Status</TableHead>
                          <TableHead className="w-[80px]"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {d.senders.map((s) => (
                          <TableRow key={s.id} className="text-sm">
                            <TableCell>
                              <code className="font-mono text-xs">{s.address}</code>
                            </TableCell>
                            <TableCell className="text-xs text-[var(--color-muted-foreground)]">
                              {domainNameById.get(s.domain_id) ?? (
                                <span className="font-mono">{s.domain_id.slice(0, 10)}…</span>
                              )}
                            </TableCell>
                            <TableCell>
                              {s.default_for_mailbox ? (
                                <Badge variant="success">default</Badge>
                              ) : null}
                            </TableCell>
                            <TableCell>
                              <StatusBadge
                                kind="credential"
                                value={s.disabled_at ? 'disabled' : 'active'}
                              />
                            </TableCell>
                            <TableCell>
                              {s.disabled_at ? null : (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() =>
                                    setConfirmDisableSender({ id: s.id, address: s.address })
                                  }
                                  disabled={disableSender.isPending}
                                >
                                  Disable
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </section>

              <section>
                <header className="mb-3 flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-semibold">Receivers</h2>
                    <p className="text-xs text-[var(--color-muted-foreground)]">
                      Inbound match rules — lower priority runs first.
                    </p>
                  </div>
                  <AddReceiverDialog mailboxId={id} />
                </header>
                {d.receivers.length === 0 ? (
                  <EmptyState
                    title="No receivers yet"
                    description="Add one to accept inbound mail at this mailbox."
                    icon={<Inbox className="h-5 w-5" aria-hidden />}
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[70px]">Prio</TableHead>
                          <TableHead>Pattern</TableHead>
                          <TableHead>Domain</TableHead>
                          <TableHead>Action</TableHead>
                          <TableHead className="w-[100px]">Status</TableHead>
                          <TableHead className="w-[80px]"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {d.receivers.map((r) => (
                          <TableRow key={r.id} className="text-sm">
                            <TableCell className="text-xs">{r.priority}</TableCell>
                            <TableCell>
                              <code className="font-mono text-xs">{r.address_pattern}</code>
                              {r.address_pattern === '*' ? (
                                <Badge variant="outline" className="ml-2">
                                  catch-all
                                </Badge>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-xs text-[var(--color-muted-foreground)]">
                              {domainNameById.get(r.domain_id) ?? (
                                <span className="font-mono">{r.domain_id.slice(0, 10)}…</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline">{r.action}</Badge>
                            </TableCell>
                            <TableCell>
                              <StatusBadge
                                kind="enabled"
                                value={r.enabled ? 'active' : 'disabled'}
                              />
                            </TableCell>
                            <TableCell>
                              {r.enabled ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() =>
                                    setConfirmDisableReceiver({
                                      id: r.id,
                                      pattern: r.address_pattern,
                                    })
                                  }
                                  disabled={disableReceiver.isPending}
                                >
                                  Disable
                                </Button>
                              ) : null}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </section>
            </div>
          </TabsContent>

          {/* ---------- Credentials ---------- */}
          <TabsContent value="credentials">
            <section>
              <header className="mb-3 flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold">Credentials</h2>
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    SMTPS / IMAP passwords issued for this mailbox. A row never used in 90+ days is
                    flagged.
                  </p>
                </div>
                <IssueCredentialDialog mailboxId={id} />
              </header>
              {d.credentials.length === 0 ? (
                <EmptyState
                  title="No credentials yet"
                  description="Issue one to enable SMTPS submission or IMAP read."
                  icon={<KeyRound className="h-5 w-5" aria-hidden />}
                />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[90px]">Protocol</TableHead>
                        <TableHead>Username</TableHead>
                        <TableHead className="w-[100px]">Status</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead>Last used</TableHead>
                        <TableHead className="w-[160px]"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.credentials.map((c) => {
                        const stale = isStaleCredential(c, now);
                        return (
                          <TableRow
                            key={c.id}
                            className={cn(
                              'text-sm',
                              stale ? 'border-l-2 border-l-[var(--color-warning)]' : null,
                            )}
                          >
                            <TableCell>
                              <Badge variant="outline">{c.type}</Badge>
                            </TableCell>
                            <TableCell>
                              <code className="font-mono text-xs" title={credentialIdentity(c)}>
                                {c.display_name ?? credentialIdentity(c)}
                              </code>
                            </TableCell>
                            <TableCell>
                              <StatusBadge
                                kind="credential"
                                value={c.disabled_at ? 'disabled' : 'active'}
                              />
                            </TableCell>
                            <TableCell>
                              <When iso={c.created_at} />
                            </TableCell>
                            <TableCell>
                              {c.last_used_at ? (
                                <span
                                  className={
                                    stale
                                      ? 'text-xs font-medium text-[var(--color-warning)]'
                                      : 'text-xs text-[var(--color-muted-foreground)]'
                                  }
                                  title={formatDate(c.last_used_at)}
                                >
                                  {formatRelative(c.last_used_at)}
                                </span>
                              ) : (
                                <span className="text-xs italic text-[var(--color-warning)]">
                                  never
                                </span>
                              )}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <Link
                                  to="/credentials/$id"
                                  params={{ id: c.id }}
                                  className="text-xs underline"
                                >
                                  Manage
                                </Link>
                                {c.disabled_at ? null : (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() =>
                                      setConfirmDisableCredential({
                                        id: c.id,
                                        identity: c.display_name ?? credentialIdentity(c),
                                      })
                                    }
                                    disabled={disableCredential.isPending}
                                  >
                                    Disable
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </section>
          </TabsContent>

          {/* ---------- Webhooks ---------- */}
          <TabsContent value="webhooks">
            <section className="space-y-4">
              <header className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold">Webhook subscriptions</h2>
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    Per-event delivery to your service. Receivers in the Routing tab point here.
                  </p>
                </div>
                <CreateWebhookSubDialog mailboxId={id} />
              </header>

              {/* DLQ cross-link — only renders when there's something to
                  investigate. Counts entries belonging to this mailbox's
                  webhook subs. */}
              {dlqForMailbox.length > 0 ? (
                <div
                  className="flex items-start gap-3 rounded-md border border-[var(--color-border)] p-4"
                  style={{
                    background:
                      'color-mix(in oklch, var(--color-card) 86%, var(--color-destructive) 14%)',
                  }}
                >
                  <ShieldCheck
                    className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-destructive)]"
                    aria-hidden
                  />
                  <div className="flex-1 text-sm">
                    <p className="font-medium">
                      {dlqForMailbox.length} dead-lettered deliver
                      {dlqForMailbox.length === 1 ? 'y' : 'ies'}
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                      Failed webhook deliveries belonging to this mailbox's subs are sitting in the
                      DLQ. Replay or drop them from the DLQ browser.
                    </p>
                  </div>
                  <Link
                    to="/dlq"
                    className={cn(
                      'inline-flex h-8 items-center rounded-md border border-[var(--color-border)] px-3 text-xs font-medium',
                      'hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-foreground)]',
                    )}
                  >
                    Open DLQ →
                  </Link>
                </div>
              ) : null}

              {d.webhook_subs.length === 0 ? (
                <EmptyState
                  title="No webhook subscriptions yet"
                  description="Add one to fan out per-event payloads to your service."
                  icon={<WebhookIcon className="h-5 w-5" aria-hidden />}
                />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>URL</TableHead>
                        <TableHead className="w-[100px]">Kind</TableHead>
                        <TableHead>Events</TableHead>
                        <TableHead className="w-[100px]">Status</TableHead>
                        <TableHead className="w-[180px]"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.webhook_subs.map((w) => (
                        <TableRow key={w.id} className="text-sm">
                          <TableCell className="max-w-md truncate font-mono text-xs">
                            <Link
                              to="/webhook-subs/$id"
                              params={{ id: w.id }}
                              className="underline"
                              title={w.url}
                            >
                              {w.url}
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{w.kind}</Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-[var(--color-muted-foreground)]">
                            {w.events}
                          </TableCell>
                          <TableCell>
                            <StatusBadge kind="webhook" value={w.paused_at ? 'paused' : 'active'} />
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  pauseWebhookSub.mutate({
                                    subId: w.id,
                                    pause: !w.paused_at,
                                  })
                                }
                                disabled={pauseWebhookSub.isPending}
                              >
                                {w.paused_at ? 'Resume' : 'Pause'}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setConfirmDeleteWebhook({ id: w.id, url: w.url })}
                                disabled={deleteWebhookSub.isPending}
                              >
                                Delete
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </section>
          </TabsContent>

          {/* ---------- Activity ---------- */}
          <TabsContent value="activity">
            <section className="space-y-4">
              <header className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-base font-semibold">Recent activity</h2>
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    Last 50 messages per direction — click a row to drill into the full message
                    detail.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <SegmentedControl
                    ariaLabel="Direction"
                    value={activityDir}
                    onChange={setActivityDir}
                    options={[
                      { value: 'all', label: 'All' },
                      { value: 'out', label: 'Sent' },
                      { value: 'in', label: 'Received' },
                    ]}
                  />
                  <Link
                    to="/messages"
                    className={cn(
                      'inline-flex h-8 items-center rounded-md border border-[var(--color-border)] px-3 text-xs font-medium',
                      'hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-foreground)]',
                    )}
                  >
                    Open Messages →
                  </Link>
                </div>
              </header>
              <ActivityTable
                rows={
                  activityDir === 'all'
                    ? mixedRecent
                    : activityDir === 'out'
                      ? sentRows
                      : receivedRows
                }
                loading={recentSent.isLoading || recentReceived.isLoading}
                emptyMessage={
                  activityDir === 'in'
                    ? 'Nothing received yet. Add a receiver to accept inbound mail.'
                    : activityDir === 'out'
                      ? 'Nothing sent yet. Use Send test to verify outbound.'
                      : 'No messages have flowed through this mailbox yet.'
                }
              />
            </section>
          </TabsContent>
        </Tabs>

        {/* ---------- destructive-action dialogs ----------
            Centralised here so the JSX inside the tables stays focused on
            displaying rows; the dialogs are global to the page. */}
        <DestructiveActionDialog
          open={confirmDisableSender != null}
          onOpenChange={(o) => !o && setConfirmDisableSender(null)}
          action="Disable sender"
          name={confirmDisableSender?.address}
          blastRadius={[
            'Outbound messages using this address will be rejected',
            'In-flight messages already in the outbound queue will still be sent',
            'You can recreate the sender later, but the previous binding is removed',
          ]}
          reversible={false}
          confirmLabel="Disable sender"
          onConfirm={async () => {
            if (!confirmDisableSender) return;
            await disableSender.mutateAsync({ senderId: confirmDisableSender.id });
            setConfirmDisableSender(null);
          }}
          isPending={disableSender.isPending}
        />

        <DestructiveActionDialog
          open={confirmDisableReceiver != null}
          onOpenChange={(o) => !o && setConfirmDisableReceiver(null)}
          action="Disable receiver"
          name={confirmDisableReceiver?.pattern}
          blastRadius={[
            'Inbound mail matching this pattern stops being routed to this mailbox',
            'Mail will fall through to the next matching receiver, or be rejected',
            'You can recreate the receiver later',
          ]}
          reversible={false}
          confirmLabel="Disable receiver"
          onConfirm={async () => {
            if (!confirmDisableReceiver) return;
            await disableReceiver.mutateAsync({ receiverId: confirmDisableReceiver.id });
            setConfirmDisableReceiver(null);
          }}
          isPending={disableReceiver.isPending}
        />

        <DestructiveActionDialog
          open={confirmDisableCredential != null}
          onOpenChange={(o) => !o && setConfirmDisableCredential(null)}
          action="Disable credential"
          name={confirmDisableCredential?.identity}
          blastRadius={[
            'Existing logins using this credential will be rejected immediately',
            'In-flight sessions terminate on the next auth check (≤60s)',
            'You can issue a fresh credential afterward; the disabled row remains for audit',
          ]}
          reversible={false}
          confirmLabel="Disable credential"
          onConfirm={async () => {
            if (!confirmDisableCredential) return;
            await disableCredential.mutateAsync({ credId: confirmDisableCredential.id });
            setConfirmDisableCredential(null);
          }}
          isPending={disableCredential.isPending}
        />

        <DestructiveActionDialog
          open={confirmDeleteWebhook != null}
          onOpenChange={(o) => !o && setConfirmDeleteWebhook(null)}
          action="Delete webhook subscription"
          name={confirmDeleteWebhook?.url}
          blastRadius={[
            'No further events will be delivered to this URL',
            'In-flight deliveries finish their existing retry budget',
            'Receivers wired to this subscription stop routing — review the Routing tab',
          ]}
          reversible={false}
          confirmLabel="Delete"
          onConfirm={async () => {
            if (!confirmDeleteWebhook) return;
            await deleteWebhookSub.mutateAsync({ subId: confirmDeleteWebhook.id });
            setConfirmDeleteWebhook(null);
          }}
          isPending={deleteWebhookSub.isPending}
        />

        <DestructiveActionDialog
          open={confirmDisableMailbox}
          onOpenChange={setConfirmDisableMailbox}
          action="Disable mailbox"
          name={d.mailbox.name}
          blastRadius={[
            'New API/SMTPS submissions targeting this mailbox will be rejected',
            'Inbound mail matching this mailbox will fall through to other receivers',
            'Webhook subscriptions stay configured but receive no new events',
            'Re-enable any time — disabled rows are not destroyed',
          ]}
          reversible
          typedConfirmation={d.mailbox.name}
          confirmLabel="Disable mailbox"
          onConfirm={async () => {
            await setMailboxDisabled.mutateAsync({ disable: true });
            setConfirmDisableMailbox(false);
          }}
          isPending={setMailboxDisabled.isPending}
        />
      </div>
    </PageCard>
  );
}

// ---------- supporting components ----------

/**
 * A compact "what's in this tab" tile rendered on the Overview tab. Clicking
 * jumps to the corresponding tab — fewer steps from "I have an alert" to
 * "I'm looking at the table".
 */
function OverviewMiniCard({
  icon,
  label,
  primary,
  secondary,
  warn,
  onOpen,
}: {
  icon: React.ReactNode;
  label: string;
  primary: string;
  secondary?: string;
  warn?: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'group flex items-start gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-3 text-left transition-colors',
        'hover:border-[var(--color-primary)] hover:bg-[color-mix(in_oklch,var(--color-card)_94%,var(--color-primary)_6%)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]',
      )}
    >
      <div
        className={cn(
          'mt-0.5 shrink-0 rounded-md p-1.5',
          warn
            ? 'bg-[color-mix(in_oklch,var(--color-card)_80%,var(--color-warning)_20%)] text-[var(--color-warning)]'
            : 'bg-[var(--color-secondary)] text-[var(--color-muted-foreground)] group-hover:text-[var(--color-primary)]',
        )}
        aria-hidden
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
          {label}
        </div>
        <div className="mt-0.5 text-sm font-semibold">{primary}</div>
        {secondary ? (
          <div
            className={cn(
              'mt-0.5 text-xs',
              warn ? 'text-[var(--color-warning)]' : 'text-[var(--color-muted-foreground)]',
            )}
          >
            {secondary}
          </div>
        ) : null}
      </div>
    </button>
  );
}

/**
 * Memo-merge of the sent + received feeds, sorted by `created_at` desc.
 * Plain `useMemo` would do — wrapping it in a named helper keeps the body
 * of `MailboxDetail` readable without splitting another component out.
 */
function useMemoMerge(sent: RecentMessageRow[], received: RecentMessageRow[]): RecentMessageRow[] {
  return useMemo(() => {
    const merged = [...sent, ...received];
    merged.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return merged;
  }, [sent, received]);
}
