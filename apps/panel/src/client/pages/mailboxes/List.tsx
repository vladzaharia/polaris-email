// Mailboxes list — table over v_mailbox_summary via GET /v1/admin/mailboxes.
//
// "Create mailbox" multi-step wizard is co-located here as a Dialog. The
// wizard walks through:
//   1. Name + description.
//   2. (optional) First sender — domain + local-part + default flag.
//   3. (optional) First receiver — domain + address pattern + drop action.
//   4. (optional) First credential — SMTPS/IMAP password issued read-once.
//
// Each step's POST happens at "Next" so the operator can opt out of later
// steps by clicking "Skip / Finish". Any failure in a later step leaves the
// mailbox + earlier sub-resources intact; the operator can finish setup from
// the detail page.
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
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
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { credentialKeys, domainKeys, mailboxKeys } from '../../queryKeys.js';

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

function CreateMailboxWizard() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);

  // step 1 — mailbox
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mailboxId, setMailboxId] = useState<string | null>(null);

  // step 2 — sender
  const [senderDomainId, setSenderDomainId] = useState('');
  const [senderLocalPart, setSenderLocalPart] = useState('');
  const [senderDefault, setSenderDefault] = useState(true);

  // step 3 — receiver
  const [receiverDomainId, setReceiverDomainId] = useState('');
  const [receiverPattern, setReceiverPattern] = useState('*');

  // step 4 — credential
  const [credUsername, setCredUsername] = useState('');
  const [credProtocol, setCredProtocol] = useState<Protocol>('smtps');
  const [credentialReveal, setCredentialReveal] = useState<{
    username: string;
    plaintext: string;
  } | null>(null);

  const [stepError, setStepError] = useState<string | null>(null);

  const domains = useAdminQuery<{ data: DomainRow[] }>(domainKeys.list(), '/api/admin/domains');

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
    setStep(1);
    setName('');
    setDescription('');
    setMailboxId(null);
    setSenderDomainId('');
    setSenderLocalPart('');
    setSenderDefault(true);
    setReceiverDomainId('');
    setReceiverPattern('*');
    setCredUsername('');
    setCredProtocol('smtps');
    setStepError(null);
    createMailbox.reset();
    addSender.reset();
    addReceiver.reset();
    issueCredential.reset();
  };

  const domainList = domains.data?.data ?? [];

  const goNext = async () => {
    setStepError(null);
    try {
      if (step === 1) {
        // Commit the mailbox so subsequent steps can hit per-mailbox routes.
        const r = await createMailbox.mutateAsync({
          name: name.trim(),
          description: description.trim() || undefined,
        });
        setMailboxId(r.id);
        setStep(2);
      } else if (step === 2) {
        if (mailboxId && senderDomainId && senderLocalPart.trim()) {
          await addSender.mutateAsync({
            mailboxId,
            domain_id: senderDomainId,
            local_part: senderLocalPart.trim(),
            default_for_mailbox: senderDefault,
          });
        }
        setStep(3);
      } else if (step === 3) {
        if (mailboxId && receiverDomainId && receiverPattern.trim()) {
          await addReceiver.mutateAsync({
            mailboxId,
            domain_id: receiverDomainId,
            address_pattern: receiverPattern.trim(),
            action: 'drop',
          });
        }
        setStep(4);
      }
    } catch (err) {
      setStepError(err instanceof Error ? err.message : String(err));
    }
  };

  const finish = async () => {
    setStepError(null);
    try {
      if (mailboxId && credUsername.trim()) {
        const r = await issueCredential.mutateAsync({
          mailboxId,
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
      setStepError(err instanceof Error ? err.message : String(err));
    }
  };

  const stepPending =
    createMailbox.isPending ||
    addSender.isPending ||
    addReceiver.isPending ||
    issueCredential.isPending;
  const canCommitStep1 = name.trim().length > 0;

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
          <Button>Create mailbox</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create mailbox — step {step} of 4</DialogTitle>
            <DialogDescription>
              Names, senders, receivers, then issue an optional credential.
            </DialogDescription>
          </DialogHeader>
          {step === 1 ? (
            <div className="space-y-3">
              <div>
                <Label htmlFor="mb-name">Name</Label>
                <Input
                  id="mb-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div>
                <Label htmlFor="mb-desc">Description (optional)</Label>
                <Input
                  id="mb-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            </div>
          ) : null}
          {step === 2 ? (
            <div className="space-y-3">
              <p className="text-sm text-[var(--color-muted-foreground)]">
                Bind a sender to one of your domains. Skip if you only want inbound.
              </p>
              <div>
                <Label>Domain</Label>
                <Select value={senderDomainId || undefined} onValueChange={setSenderDomainId}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Pick a domain (optional)" />
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
              <div>
                <Label htmlFor="snd-lp">Local part</Label>
                <Input
                  id="snd-lp"
                  value={senderLocalPart}
                  onChange={(e) => setSenderLocalPart(e.target.value)}
                  placeholder="noreply"
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
            </div>
          ) : null}
          {step === 3 ? (
            <div className="space-y-3">
              <p className="text-sm text-[var(--color-muted-foreground)]">
                Optional inbound receiver — accepts mail for an address pattern under a domain.
                Defaults to the catch-all <code>*</code> with the drop action; you can refine on the
                detail page.
              </p>
              <div>
                <Label>Domain</Label>
                <Select value={receiverDomainId || undefined} onValueChange={setReceiverDomainId}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Pick a domain (optional)" />
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
              <div>
                <Label htmlFor="rcv-pat">Address pattern</Label>
                <Input
                  id="rcv-pat"
                  value={receiverPattern}
                  onChange={(e) => setReceiverPattern(e.target.value)}
                />
              </div>
            </div>
          ) : null}
          {step === 4 ? (
            <div className="space-y-3">
              <p className="text-sm text-[var(--color-muted-foreground)]">
                Optional read-once credential. Skip to finish without issuing a login.
              </p>
              <div>
                <Label htmlFor="cred-user">Username</Label>
                <Input
                  id="cred-user"
                  value={credUsername}
                  onChange={(e) => setCredUsername(e.target.value)}
                  placeholder="noreply@acme.example"
                />
              </div>
              <div>
                <Label>Protocol</Label>
                <Select value={credProtocol} onValueChange={(v) => setCredProtocol(v as Protocol)}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="smtps">SMTPS (submission)</SelectItem>
                    <SelectItem value="imap">IMAP (mailbox read)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : null}
          {stepError ? (
            <p className="text-sm text-[var(--color-destructive)]">{stepError}</p>
          ) : null}
          <DialogFooter>
            {step > 1 && step < 4 && !mailboxId ? (
              <Button variant="outline" onClick={() => setStep(step - 1)}>
                Back
              </Button>
            ) : null}
            {step < 4 ? (
              <Button onClick={goNext} disabled={stepPending || (step === 1 && !canCommitStep1)}>
                {stepPending ? 'Working…' : step === 1 ? 'Create + Next' : 'Next'}
              </Button>
            ) : (
              <Button onClick={finish} disabled={stepPending}>
                {stepPending
                  ? 'Working…'
                  : credUsername.trim()
                    ? 'Issue credential + finish'
                    : 'Finish'}
              </Button>
            )}
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
    <PageCard title="Mailboxes" description="Inbound + outbound mailbox registry." decorative>
      <div className="mb-4 flex justify-end">
        <CreateMailboxWizard />
      </div>
      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : q.error ? (
        <p className="text-sm text-[var(--color-destructive)]">{q.error.message}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">
          No mailboxes yet. Use the button above to create one.
        </p>
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
                <TableCell className="text-xs">{r.created_at}</TableCell>
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
