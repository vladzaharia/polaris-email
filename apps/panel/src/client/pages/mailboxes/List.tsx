// Mailboxes list — table over v_mailbox_summary via GET /v1/admin/mailboxes.
//
// "Create mailbox" dialog lives here. The form is single-page with three
// optional collapsible sections (sender / receiver / credential). The
// mailbox row is committed first; every section is opt-in, so the common
// "just create the mailbox and configure it later from the detail page"
// path is a single click on the Create button.
//
// Each sub-resource POST happens after the mailbox POST resolves. Any
// failure in a later step leaves the mailbox + earlier sub-resources
// intact; the operator can finish setup from the detail page.
//
// Known limitation (unchanged): if the mailbox POST succeeds but a later
// section POST fails, the panel surfaces the error inline but leaves the
// half-configured mailbox in the registry. A future refactor will batch
// these once services/api exposes a transactional bulk-create endpoint.
import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../components/ui/dialog.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { SecretRevealDialog } from '../../components/SecretRevealDialog.js';
import { ErrorText } from '../../components/ErrorText.js';
import { EmptyState } from '../../components/EmptyState.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { credentialKeys, domainKeys, mailboxKeys } from '../../queryKeys.js';
import { formatDate, formatRelative } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';

interface MailboxRow {
  id: string;
  name: string;
  description: string | null;
  active_sender_count?: number;
  active_receiver_count?: number;
  created_at: string;
  disabled_at: string | null;
}

interface DomainRow {
  id: string;
  name: string;
}

type Protocol = 'smtps' | 'imap';

// Suggested local-parts and patterns — mirror the chips on AddSenderDialog
// and AddReceiverDialog so operators see the same vocabulary throughout.
const SENDER_LOCAL_PART_SUGGESTIONS = ['noreply', 'support', 'transactional', 'bounces'];
const RECEIVER_PATTERN_SUGGESTIONS = ['*', 'support', 'webhook', 'unsubscribe'];

// Collapsible section wrapper. Header is a button; body renders only when
// open. Defaults to closed so the operator can mash "Create mailbox"
// without scrolling past three forms they don't care about.
function CollapsibleSection({
  title,
  description,
  open,
  onToggle,
  children,
}: {
  title: string;
  description: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-[var(--color-border)]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left hover:bg-[var(--color-muted)]"
      >
        <div>
          <div className="text-sm font-medium text-[var(--color-foreground)]">{title}</div>
          <div className="text-xs text-[var(--color-muted-foreground)]">{description}</div>
        </div>
        {open ? (
          <ChevronDown className="h-4 w-4 text-[var(--color-muted-foreground)]" />
        ) : (
          <ChevronRight className="h-4 w-4 text-[var(--color-muted-foreground)]" />
        )}
      </button>
      {open ? (
        <div className="space-y-3 border-t border-[var(--color-border)] p-3">{children}</div>
      ) : null}
    </div>
  );
}

// Compact chip row reused by sender / receiver suggestion buttons.
function SuggestionChips({
  values,
  onPick,
}: {
  values: ReadonlyArray<string>;
  onPick: (v: string) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {values.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onPick(s)}
          className="cursor-pointer rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-muted-foreground)] hover:border-[var(--color-primary)] hover:text-[var(--color-foreground)]"
        >
          {s}
        </button>
      ))}
    </div>
  );
}

function CreateMailboxWizard() {
  const [open, setOpen] = useState(false);

  // Mailbox basics.
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  // Sender section.
  const [senderOpen, setSenderOpen] = useState(false);
  const [senderDomainId, setSenderDomainId] = useState('');
  const [senderLocalPart, setSenderLocalPart] = useState('');
  const [senderDefault, setSenderDefault] = useState(true);

  // Receiver section.
  const [receiverOpen, setReceiverOpen] = useState(false);
  const [receiverDomainId, setReceiverDomainId] = useState('');
  const [receiverPattern, setReceiverPattern] = useState('*');

  // Credential section.
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [credUsername, setCredUsername] = useState('');
  const [credProtocol, setCredProtocol] = useState<Protocol>('smtps');

  const [credentialReveal, setCredentialReveal] = useState<{
    username: string;
    plaintext: string;
  } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const domains = useAdminQuery<{ data: DomainRow[] }>(domainKeys.list(), '/api/admin/domains');
  // Read off the query result directly so the effect dep is the (stable)
  // query data object rather than a freshly-allocated `[]` every render.
  const domainRows = domains.data?.data;
  const domainList = domainRows ?? [];

  // Default-to-first domain for both sender and receiver pickers, matching
  // the AddSenderDialog / AddReceiverDialog behaviour on the detail page.
  useEffect(() => {
    if (!domainRows || domainRows.length === 0) return;
    if (!senderDomainId) setSenderDomainId(domainRows[0]!.id);
    if (!receiverDomainId) setReceiverDomainId(domainRows[0]!.id);
  }, [senderDomainId, receiverDomainId, domainRows]);

  const selectedSenderDomain = domainList.find((d) => d.id === senderDomainId);
  const selectedReceiverDomain = domainList.find((d) => d.id === receiverDomainId);

  const createMailbox = useAdminMutation<{ id: string }, { name: string; description?: string }>(
    (vars) => ({ path: '/api/admin/mailboxes', method: 'POST', body: vars }),
    {
      invalidateKeys: [mailboxKeys.all],
      silent: true,
    },
  );
  const addSender = useAdminMutation<
    unknown,
    {
      mailboxId: string;
      domain_id: string;
      local_part: string;
      default_for_mailbox: boolean;
    }
  >(
    ({ mailboxId: id, ...body }) => ({
      path: `/api/admin/mailboxes/${id}/senders`,
      method: 'POST',
      body,
    }),
    { invalidateKeys: [mailboxKeys.all], silent: true },
  );
  const addReceiver = useAdminMutation<
    unknown,
    { mailboxId: string; domain_id: string; address_pattern: string; action: 'drop' }
  >(
    ({ mailboxId: id, ...body }) => ({
      path: `/api/admin/mailboxes/${id}/receivers`,
      method: 'POST',
      body: { ...body, priority: 100 },
    }),
    { invalidateKeys: [mailboxKeys.all], silent: true },
  );
  const issueCredential = useAdminMutation<
    { id: string; plaintext: string },
    { mailboxId: string; protocol: Protocol; username: string }
  >(
    ({ mailboxId: id, protocol, username }) => ({
      path: `/api/admin/mailboxes/${id}/credentials`,
      method: 'POST',
      body: { protocol, username },
    }),
    { invalidateKeys: [credentialKeys.all], silent: true },
  );

  const fullReset = () => {
    setName('');
    setDescription('');
    setSenderOpen(false);
    setSenderDomainId(domainList[0]?.id ?? '');
    setSenderLocalPart('');
    setSenderDefault(true);
    setReceiverOpen(false);
    setReceiverDomainId(domainList[0]?.id ?? '');
    setReceiverPattern('*');
    setCredentialOpen(false);
    setCredUsername('');
    setCredProtocol('smtps');
    setFormError(null);
    createMailbox.reset();
    addSender.reset();
    addReceiver.reset();
    issueCredential.reset();
  };

  const isPending =
    createMailbox.isPending ||
    addSender.isPending ||
    addReceiver.isPending ||
    issueCredential.isPending;
  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !isPending;

  // Detect which sub-resource sections are actually populated. Empty
  // collapsibles are silently ignored so the operator can open + abandon a
  // section without affecting the POST.
  const shouldCreateSender =
    senderOpen && senderDomainId.length > 0 && senderLocalPart.trim().length > 0;
  const shouldCreateReceiver =
    receiverOpen && receiverDomainId.length > 0 && receiverPattern.trim().length > 0;
  const shouldIssueCredential = credentialOpen && credUsername.trim().length > 0;

  const submit = async () => {
    setFormError(null);
    try {
      const m = await createMailbox.mutateAsync({
        name: trimmedName,
        description: description.trim() || undefined,
      });
      if (shouldCreateSender) {
        await addSender.mutateAsync({
          mailboxId: m.id,
          domain_id: senderDomainId,
          local_part: senderLocalPart.trim(),
          default_for_mailbox: senderDefault,
        });
      }
      if (shouldCreateReceiver) {
        await addReceiver.mutateAsync({
          mailboxId: m.id,
          domain_id: receiverDomainId,
          address_pattern: receiverPattern.trim(),
          action: 'drop',
        });
      }
      if (shouldIssueCredential) {
        const r = await issueCredential.mutateAsync({
          mailboxId: m.id,
          protocol: credProtocol,
          username: credUsername.trim(),
        });
        if (r?.plaintext) {
          setCredentialReveal({ username: credUsername.trim(), plaintext: r.plaintext });
        }
      }
      setOpen(false);
      fullReset();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  };

  const senderPreview =
    selectedSenderDomain && senderLocalPart.trim()
      ? `${senderLocalPart.trim()}@${selectedSenderDomain.name}`
      : null;
  const receiverPreview =
    selectedReceiverDomain && receiverPattern.trim()
      ? `${receiverPattern.trim()}@${selectedReceiverDomain.name}`
      : null;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) fullReset();
        }}
      >
        <DialogTrigger asChild>
          <Button size="sm">
            <Plus className="h-4 w-4" /> Add mailbox
          </Button>
        </DialogTrigger>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create mailbox</DialogTitle>
            <DialogDescription>
              Name the mailbox; senders, receivers, and credentials are optional and can also be
              added from the mailbox detail page.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="mb-name">Name</Label>
              <Input
                id="mb-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="customer-success"
                autoComplete="off"
                className="mt-1"
              />
              {trimmedName ? (
                <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                  Will create mailbox <span className="font-mono">{trimmedName}</span>.
                </p>
              ) : null}
            </div>
            <div>
              <Label htmlFor="mb-desc">Description (optional)</Label>
              <Input
                id="mb-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What is this mailbox for?"
                className="mt-1"
              />
            </div>

            <CollapsibleSection
              title="Add a sender"
              description="Bind an outbound From-address. You can add senders later."
              open={senderOpen}
              onToggle={() => setSenderOpen((v) => !v)}
            >
              <div>
                <Label>Address</Label>
                <div className="mt-1 flex items-stretch gap-1.5">
                  <Input
                    value={senderLocalPart}
                    onChange={(e) => setSenderLocalPart(e.target.value)}
                    placeholder="noreply"
                    autoComplete="off"
                    spellCheck={false}
                    className="flex-1"
                  />
                  <span className="flex items-center text-sm text-[var(--color-muted-foreground)]">
                    @
                  </span>
                  <Select value={senderDomainId || undefined} onValueChange={setSenderDomainId}>
                    <SelectTrigger className="flex-1" disabled={domains.isLoading}>
                      <SelectValue
                        placeholder={domains.isLoading ? 'Loading domains…' : 'Pick a domain'}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {domainList.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {senderPreview ? (
                  <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                    Will register: <span className="font-mono">{senderPreview}</span>
                  </p>
                ) : null}
                <SuggestionChips
                  values={SENDER_LOCAL_PART_SUGGESTIONS}
                  onPick={setSenderLocalPart}
                />
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="snd-default"
                  checked={senderDefault}
                  onCheckedChange={setSenderDefault}
                />
                <Label htmlFor="snd-default">Default sender for this mailbox</Label>
              </div>
            </CollapsibleSection>

            <CollapsibleSection
              title="Add a receiver"
              description="Optional inbound match rule; defaults to catch-all + drop."
              open={receiverOpen}
              onToggle={() => setReceiverOpen((v) => !v)}
            >
              <div>
                <Label>Match pattern</Label>
                <div className="mt-1 flex items-stretch gap-1.5">
                  <Input
                    value={receiverPattern}
                    onChange={(e) => setReceiverPattern(e.target.value)}
                    placeholder="* or local-part"
                    autoComplete="off"
                    spellCheck={false}
                    className="flex-1"
                  />
                  <span className="flex items-center text-sm text-[var(--color-muted-foreground)]">
                    @
                  </span>
                  <Select value={receiverDomainId || undefined} onValueChange={setReceiverDomainId}>
                    <SelectTrigger className="flex-1" disabled={domains.isLoading}>
                      <SelectValue
                        placeholder={domains.isLoading ? 'Loading domains…' : 'Pick a domain'}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {domainList.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {receiverPreview ? (
                  <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                    Will match: <span className="font-mono">{receiverPreview}</span> —{' '}
                    <span className="italic">
                      {receiverPattern === '*' ? 'catch-all (drop)' : 'exact (drop)'}
                    </span>
                  </p>
                ) : null}
                <SuggestionChips
                  values={RECEIVER_PATTERN_SUGGESTIONS}
                  onPick={setReceiverPattern}
                />
              </div>
              <p className="text-xs text-[var(--color-muted-foreground)]">
                Action is hard-coded to <span className="font-mono">drop</span> here. Wire a webhook
                or forward target from the mailbox detail page.
              </p>
            </CollapsibleSection>

            <CollapsibleSection
              title="Issue a credential"
              description="Optional read-once SMTPS / IMAP password."
              open={credentialOpen}
              onToggle={() => setCredentialOpen((v) => !v)}
            >
              <div>
                <Label>Protocol</Label>
                <div
                  role="radiogroup"
                  aria-label="Protocol"
                  className="mt-1 inline-flex rounded-md border border-[var(--color-border)] bg-[var(--color-muted)] p-0.5"
                >
                  {[
                    { v: 'smtps' as const, label: 'SMTPS', hint: 'submission' },
                    { v: 'imap' as const, label: 'IMAP', hint: 'mailbox read' },
                  ].map((opt) => {
                    const selected = credProtocol === opt.v;
                    return (
                      <button
                        key={opt.v}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setCredProtocol(opt.v)}
                        className={cn(
                          'cursor-pointer rounded px-3 py-1 text-xs font-medium transition-colors',
                          selected
                            ? 'bg-[var(--color-background)] text-[var(--color-foreground)] shadow-sm'
                            : 'text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]',
                        )}
                      >
                        <span className="font-mono">{opt.label}</span>
                        <span className="ml-1 text-[var(--color-muted-foreground)]">
                          {opt.hint}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <Label htmlFor="cred-user">Username</Label>
                <Input
                  id="cred-user"
                  value={credUsername}
                  onChange={(e) => setCredUsername(e.target.value)}
                  placeholder={senderPreview ?? 'noreply@acme.example'}
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-1"
                />
                <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                  Password is shown once after creation; Polaris stores only the bcrypt hash.
                </p>
              </div>
            </CollapsibleSection>

            <ErrorText error={formError} />
          </div>
          <DialogFooter>
            <Button size="sm" onClick={submit} disabled={!canSubmit}>
              {isPending ? 'Creating…' : 'Create mailbox'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SecretRevealDialog
        open={credentialReveal != null}
        onOpenChange={(o) => !o && setCredentialReveal(null)}
        title={`Credential issued for ${credentialReveal?.username ?? ''}`}
        secretLabel="Password"
        secret={credentialReveal?.plaintext ?? null}
        note="Use this with the username for SMTPS LOGIN or IMAP AUTHENTICATE. Polaris stores only the bcrypt hash — there is no way to retrieve this value again."
      />
    </>
  );
}

export function MailboxesList() {
  const q = useAdminQuery<{ data: MailboxRow[] }>(mailboxKeys.list(), '/api/admin/mailboxes');
  const rows = q.data?.data ?? [];
  return (
    <PageCard
      title="Mailboxes"
      description="Inbound + outbound mailbox registry."
      decorative
      actions={<CreateMailboxWizard />}
    >
      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState title="No mailboxes yet" description="Use the button above to create one." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Senders</TableHead>
              <TableHead>Receivers</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <Link to="/mailboxes/$id" params={{ id: r.id }} className="underline">
                    {r.name}
                  </Link>
                </TableCell>
                <TableCell>{r.description ?? '—'}</TableCell>
                <TableCell>{r.active_sender_count ?? 0}</TableCell>
                <TableCell>{r.active_receiver_count ?? 0}</TableCell>
                <TableCell className="text-xs" title={formatDate(r.created_at)}>
                  {formatRelative(r.created_at)}
                </TableCell>
                <TableCell>
                  <StatusBadge kind="credential" value={r.disabled_at ? 'disabled' : 'active'} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PageCard>
  );
}
