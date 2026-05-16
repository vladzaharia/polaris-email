// Credentials list — union of api_keys + smtp_credentials via
// GET /v1/admin/credentials?mailbox=<id>.
//
// "Issue credential" mounts a Dialog that POSTs to
// /v1/admin/mailboxes/:id/credentials (read-once: returns the plaintext
// password exactly once). The dialog opens SecretRevealDialog on success.
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { PageCard } from '../../layouts/PageCard.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
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
import { StatusBadge } from '../../components/StatusBadge.js';
import { SecretRevealDialog } from '../../components/SecretRevealDialog.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { credentialKeys, mailboxKeys } from '../../queryKeys.js';
import { formatDate, formatRelative } from '../../lib/format.js';
import { ErrorText } from '../../components/ErrorText.js';
import { EmptyState } from '../../components/EmptyState.js';

interface MailboxRow {
  id: string;
  name: string;
}

interface CredRow {
  kind: 'api_key' | 'smtp';
  id: string;
  status: string;
  created_at: string;
  username?: string;
}

type Protocol = 'smtps' | 'imap';

function IssueCredentialDialog({ mailboxes }: { mailboxes: MailboxRow[] }) {
  const [open, setOpen] = useState(false);
  const [mailboxId, setMailboxId] = useState('');
  const [protocol, setProtocol] = useState<Protocol>('smtps');
  const [username, setUsername] = useState('');
  const [reveal, setReveal] = useState<{ username: string; plaintext: string } | null>(null);

  const issue = useAdminMutation<
    { id: string; plaintext: string },
    { mailboxId: string; protocol: Protocol; username: string }
  >(
    (vars) => ({
      path: `/api/admin/mailboxes/${vars.mailboxId}/credentials`,
      method: 'POST',
      body: { protocol: vars.protocol, username: vars.username },
    }),
    { invalidateKeys: [credentialKeys.all], silent: true },
  );

  const reset = () => {
    setMailboxId('');
    setProtocol('smtps');
    setUsername('');
    issue.reset();
  };

  const canSubmit = !!mailboxId && username.trim().length > 0 && !issue.isPending;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset();
        }}
      >
        <DialogTrigger asChild>
          <Button>Issue credential</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Issue mailbox credential</DialogTitle>
            <DialogDescription>
              Mints a password for SMTPS or IMAP login bound to a mailbox. The plaintext is shown
              once; the database only stores its bcrypt hash.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Mailbox</Label>
              <Select value={mailboxId || undefined} onValueChange={setMailboxId}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Pick a mailbox" />
                </SelectTrigger>
                <SelectContent>
                  {mailboxes.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Protocol</Label>
              <Select value={protocol} onValueChange={(v) => setProtocol(v as Protocol)}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="smtps">SMTPS (submission)</SelectItem>
                  <SelectItem value="imap">IMAP (mailbox read)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="cred-user">Username</Label>
              <Input
                id="cred-user"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. noreply@acme.example"
              />
            </div>
            <ErrorText error={issue.error} />
          </div>
          <DialogFooter>
            <Button
              onClick={async () => {
                const r = await issue.mutateAsync({
                  mailboxId,
                  protocol,
                  username: username.trim(),
                });
                if (r?.plaintext) {
                  setReveal({ username: username.trim(), plaintext: r.plaintext });
                }
                setOpen(false);
                reset();
              }}
              disabled={!canSubmit}
            >
              {issue.isPending ? 'Issuing…' : 'Issue'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SecretRevealDialog
        open={reveal != null}
        onOpenChange={(o) => !o && setReveal(null)}
        title={`Credential issued for ${reveal?.username ?? ''}`}
        secretLabel="Password"
        secret={reveal?.plaintext ?? null}
        note="Use this with the username for SMTPS LOGIN or IMAP AUTHENTICATE. Polaris stores only the bcrypt hash — there is no way to retrieve this value again."
      />
    </>
  );
}

export function CredentialsList() {
  const mailboxes = useAdminQuery<{ data: MailboxRow[] }>(
    mailboxKeys.list(),
    '/api/admin/mailboxes',
  );
  const [mailboxId, setMailboxId] = useState<string>('');
  const creds = useAdminQuery<{ data: CredRow[] }>(
    credentialKeys.list(mailboxId),
    `/api/admin/credentials?mailbox=${mailboxId}`,
    { enabled: !!mailboxId },
  );
  const mailboxList = mailboxes.data?.data ?? [];
  return (
    <PageCard
      title="Credentials"
      description="API keys + SMTP credentials, scoped per mailbox."
      decorative
    >
      <div className="mb-4 flex items-end justify-between gap-4">
        <div className="max-w-sm flex-1">
          <Label>Mailbox</Label>
          <Select value={mailboxId || undefined} onValueChange={setMailboxId}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Pick a mailbox" />
            </SelectTrigger>
            <SelectContent>
              {mailboxList.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <IssueCredentialDialog mailboxes={mailboxList} />
      </div>
      {!mailboxId ? (
        <EmptyState
          title="Pick a mailbox to list credentials"
          description="Credentials are scoped to a single mailbox; choose one from the dropdown above."
        />
      ) : creds.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : creds.error ? (
        <ErrorText error={creds.error} />
      ) : (creds.data?.data ?? []).length === 0 ? (
        <EmptyState
          title="No credentials"
          description="This mailbox has no API keys or SMTP credentials yet. Use the button above to issue one."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Username</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(creds.data?.data ?? []).map((c) => (
              <TableRow key={`${c.kind}:${c.id}`}>
                <TableCell>
                  <Link to="/credentials/$id" params={{ id: c.id }} className="underline">
                    {c.id}
                  </Link>
                </TableCell>
                <TableCell>{c.kind}</TableCell>
                <TableCell className="font-mono text-xs">{c.username ?? '—'}</TableCell>
                <TableCell>
                  <StatusBadge kind="credential" value={c.status} />
                </TableCell>
                <TableCell className="text-xs" title={formatDate(c.created_at)}>
                  {formatRelative(c.created_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PageCard>
  );
}
