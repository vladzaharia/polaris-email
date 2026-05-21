// Mailbox detail — header + stacked sections (Senders / Receivers /
// Credentials / Webhook subs / Recent messages). Each section has its own
// inline add Dialog so operators never have to navigate to another page to
// configure mailbox-scoped resources. Test-send mounts as an inline modal
// alongside the page header.
import { useEffect, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
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
import { Separator } from '../../components/ui/separator.js';
import { Badge } from '../../components/ui/badge.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { DestructiveActionDialog } from '../../components/DestructiveActionDialog.js';
import { ErrorText } from '../../components/ErrorText.js';
import { EmptyState } from '../../components/EmptyState.js';
import { StatTile } from '../../components/StatTile.js';
import { CompositeInput } from '../../components/CompositeInput.js';
import { SuggestionChip, SuggestionChipRow } from '../../components/SuggestionChip.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { domainKeys, mailboxKeys, webhookKeys } from '../../queryKeys.js';
import { formatDate, formatRelative } from '../../lib/format.js';
import { IssueCredentialDialog } from '../credentials/IssueCredentialDialog.js';
import { CreateWebhookSubDialog } from '../webhook-subs/CreateWebhookSubDialog.js';
import { SendTestDialog } from '../test-send/SendTestDialog.js';

interface CredentialRow {
  id: string;
  mailbox_id: string;
  protocol: 'smtps' | 'imap';
  auth_type: 'password';
  username: string;
  created_at: string;
  last_used_at: string | null;
  disabled_at: string | null;
}

interface MailboxDetailPayload {
  mailbox: {
    id: string;
    name: string;
    description: string | null;
    created_at: string;
    disabled_at: string | null;
  };
  senders: Array<{
    id: string;
    address: string;
    domain_id: string;
    default_for_mailbox: number;
    disabled_at: string | null;
  }>;
  receivers: Array<{
    id: string;
    domain_id: string;
    priority: number;
    address_pattern: string;
    action: string;
    enabled: number;
  }>;
  principals: Array<{ id: string; kind: string; display_name: string | null }>;
  webhook_subs: Array<{
    id: string;
    url: string;
    kind: string;
    events: string;
    paused_at: string | null;
    disabled_at: string | null;
  }>;
  credentials: CredentialRow[];
}

interface DomainRow {
  id: string;
  name: string;
}

// Suggested local-part chips for Add Sender. These cover ~90% of operator
// intent (transactional bounces, support inbox, generic noreply); operators
// can still type a freeform local-part for anything else.
const SENDER_LOCAL_PART_SUGGESTIONS = ['noreply', 'support', 'transactional', 'bounces'];

// Row shape used by both "Recent sent" and "Recent received" panels.
interface RecentMessageRow {
  id: string;
  subject: string | null;
  status: string;
  from_addr: string | null;
  to_addrs: string | null;
  created_at: string;
}

// One side of the split "recent activity" view. Reused for sent + received
// so the two panels stay consistent; the only differences are the title,
// empty-state copy, and which address column to render (To vs From).
function RecentMessagesPanel({
  title,
  query,
  emptyMessage,
  addressLabel,
  addressFor,
}: {
  title: string;
  query: { isLoading: boolean; data: { data: RecentMessageRow[] } | undefined };
  emptyMessage: string;
  addressLabel: string;
  addressFor: (m: RecentMessageRow) => string;
}) {
  const rows = query.data?.data ?? [];
  return (
    <section>
      <h2 className="mb-2 text-xl font-medium">{title}</h2>
      {query.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">{emptyMessage}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Subject</TableHead>
              <TableHead>{addressLabel}</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((m) => (
              <TableRow key={m.id}>
                <TableCell>
                  <Link to="/messages/$id" params={{ id: m.id }} className="underline">
                    {m.subject ?? '(no subject)'}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">{addressFor(m)}</TableCell>
                <TableCell>
                  <Badge variant="outline">{m.status}</Badge>
                </TableCell>
                <TableCell
                  className="text-xs text-[var(--color-muted-foreground)]"
                  title={formatDate(m.created_at)}
                >
                  {formatRelative(m.created_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

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
        <Button size="icon" title="Add sender" aria-label="Add sender">
          <Plus className="h-4 w-4" />
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

// Suggested receive patterns. `*` (catch-all) is overwhelmingly the most
// common; specific local-parts (`support`, `webhook`) come up for routing
// a single address to a different downstream.
const RECEIVER_PATTERN_SUGGESTIONS = ['*', 'support', 'webhook', 'unsubscribe'];

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
        <Button size="icon" title="Add receiver" aria-label="Add receiver">
          <Plus className="h-4 w-4" />
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
                  No webhook subscriptions yet — add one in the Webhook section above first.
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

export function MailboxDetail() {
  const { id } = useParams({ from: '/mailboxes/$id' });
  const q = useAdminQuery<MailboxDetailPayload>(
    mailboxKeys.detail(id),
    `/api/admin/mailboxes/${id}`,
  );
  // Direction-scoped queries so the panel can render Sent + Received side-by-
  // side. Last 10 each is plenty for "what's recent on this mailbox?".
  const recentSent = useAdminQuery<{ data: RecentMessageRow[] }>(
    mailboxKeys.recentMessages(id, 'out'),
    `/api/messages?mailbox_id=${id}&direction=out&limit=10`,
  );
  const recentReceived = useAdminQuery<{ data: RecentMessageRow[] }>(
    mailboxKeys.recentMessages(id, 'in'),
    `/api/messages?mailbox_id=${id}&direction=in&limit=10`,
  );
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
    username: string;
  } | null>(null);
  const [confirmDeleteWebhook, setConfirmDeleteWebhook] = useState<{
    id: string;
    url: string;
  } | null>(null);

  const breadcrumbs = [
    { label: 'Mailboxes', to: '/mailboxes' },
    { label: q.data?.mailbox.name ?? id },
  ];
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
  const activeSenders = d.senders.filter((s) => !s.disabled_at);
  const activeReceivers = d.receivers.filter((r) => r.enabled);
  const activeCredentials = d.credentials.filter((c) => !c.disabled_at);
  const activeWebhooks = d.webhook_subs.filter((w) => !w.disabled_at);

  const lastSentAt = recentSent.data?.data[0]?.created_at ?? null;
  const lastReceivedAt = recentReceived.data?.data[0]?.created_at ?? null;

  return (
    <PageCard
      decorative
      breadcrumbs={breadcrumbs}
      title={d.mailbox.name}
      description={d.mailbox.description ?? 'No description.'}
      actions={<SendTestDialog mailboxId={id} senders={activeSenders} />}
    >
      <div className="space-y-6">
        {/* Stats strip — quick "what is this mailbox?" glance before the
            sub-resource sections. Counts are derived from the detail payload;
            last-activity timestamps come from the recent-message queries. */}
        <section className="grid grid-cols-2 gap-2 md:grid-cols-6">
          <StatTile label="Senders" value={activeSenders.length} />
          <StatTile label="Receivers" value={activeReceivers.length} />
          <StatTile label="Credentials" value={activeCredentials.length} />
          <StatTile label="Webhooks" value={activeWebhooks.length} />
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
        </section>

        <Separator />
        <section>
          <header className="mb-2 flex items-center justify-between">
            <h2 className="text-xl font-medium">Senders</h2>
            <AddSenderDialog mailboxId={id} />
          </header>
          {d.senders.length === 0 ? (
            <EmptyState title="No senders yet" description="Add one to enable outbound mail." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Address</TableHead>
                  <TableHead>Default</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.senders.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>{s.address}</TableCell>
                    <TableCell>
                      {s.default_for_mailbox ? <Badge variant="success">default</Badge> : null}
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
                          onClick={() => setConfirmDisableSender({ id: s.id, address: s.address })}
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
          )}
        </section>

        <Separator />

        <section>
          <header className="mb-2 flex items-center justify-between">
            <h2 className="text-xl font-medium">Receivers</h2>
            <AddReceiverDialog mailboxId={id} />
          </header>
          {d.receivers.length === 0 ? (
            <EmptyState
              title="No receivers yet"
              description="Add one to accept inbound mail at this mailbox."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Priority</TableHead>
                  <TableHead>Pattern</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.receivers.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.priority}</TableCell>
                    <TableCell className="font-mono text-xs">{r.address_pattern}</TableCell>
                    <TableCell>{r.action}</TableCell>
                    <TableCell>{r.enabled ? 'yes' : 'no'}</TableCell>
                    <TableCell>
                      {r.enabled ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setConfirmDisableReceiver({ id: r.id, pattern: r.address_pattern })
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
          )}
        </section>

        <Separator />

        <section>
          <header className="mb-2 flex items-center justify-between">
            <h2 className="text-xl font-medium">Credentials</h2>
            <IssueCredentialDialog mailboxId={id} />
          </header>
          {d.credentials.length === 0 ? (
            <EmptyState
              title="No credentials yet"
              description="Issue one to enable SMTPS submission or IMAP read."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Protocol</TableHead>
                  <TableHead>Username</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.credentials.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Badge variant="outline">{c.protocol}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{c.username}</TableCell>
                    <TableCell>
                      <StatusBadge
                        kind="credential"
                        value={c.disabled_at ? 'disabled' : 'active'}
                      />
                    </TableCell>
                    <TableCell className="text-xs" title={formatDate(c.created_at)}>
                      {formatRelative(c.created_at)}
                    </TableCell>
                    <TableCell className="text-xs text-[var(--color-muted-foreground)]">
                      {c.last_used_at ? (
                        <span title={formatDate(c.last_used_at)}>
                          {formatRelative(c.last_used_at)}
                        </span>
                      ) : (
                        '—'
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
                              setConfirmDisableCredential({ id: c.id, username: c.username })
                            }
                            disabled={disableCredential.isPending}
                          >
                            Disable
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {d.principals.length > 0 ? (
            <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
              {d.principals.length} principal{d.principals.length === 1 ? '' : 's'} attached.
            </p>
          ) : null}
        </section>

        <Separator />

        <section>
          <header className="mb-2 flex items-center justify-between">
            <h2 className="text-xl font-medium">Webhook subscriptions</h2>
            <CreateWebhookSubDialog mailboxId={id} />
          </header>
          {d.webhook_subs.length === 0 ? (
            <EmptyState
              title="No webhook subscriptions yet"
              description="Add one to fan out per-event payloads to your service."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>URL</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Events</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.webhook_subs.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell className="font-mono text-xs">
                      <Link to="/webhook-subs/$id" params={{ id: w.id }} className="underline">
                        {w.url}
                      </Link>
                    </TableCell>
                    <TableCell>{w.kind}</TableCell>
                    <TableCell className="font-mono text-xs">{w.events}</TableCell>
                    <TableCell>
                      <StatusBadge kind="webhook" value={w.paused_at ? 'paused' : 'active'} />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            pauseWebhookSub.mutate({ subId: w.id, pause: !w.paused_at })
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
          )}
        </section>

        <Separator />

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
          name={confirmDisableCredential?.username}
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
            'Receivers wired to this subscription stop routing — review the Receivers section',
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

        {/* Recent activity — split sent / received so operators can scan
            both directions at once. Rows drill into /messages/$id. */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <RecentMessagesPanel
            title="Recent sent"
            query={recentSent}
            emptyMessage="Nothing sent yet."
            addressLabel="To"
            addressFor={(m) => m.to_addrs ?? '—'}
          />
          <RecentMessagesPanel
            title="Recent received"
            query={recentReceived}
            emptyMessage="Nothing received yet."
            addressLabel="From"
            addressFor={(m) => m.from_addr ?? '—'}
          />
        </div>
      </div>
    </PageCard>
  );
}
