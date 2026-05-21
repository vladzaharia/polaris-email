// Extracted from credentials/List.tsx so MailboxDetail can mount the
// "Add credential" dialog inline. Mailbox is fixed by prop (no picker),
// because every call site is already mailbox-scoped — the only caller
// outside the standalone Credentials page is MailboxDetail's Credentials
// section, which knows its own mailbox id.
//
// UX: protocol is a two-option pill toggle (Select is heavy for two
// values); operators get a "Use default sender" quick-fill when the
// mailbox has one; a preview line shows the about-to-issue identity.
import { useState } from 'react';
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
import { SecretRevealDialog } from '../../components/SecretRevealDialog.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { credentialKeys, mailboxKeys } from '../../queryKeys.js';
import { ErrorText } from '../../components/ErrorText.js';
import { SegmentedControl } from '../../components/SegmentedControl.js';

type Protocol = 'smtps' | 'imap';

const PROTOCOL_OPTIONS: ReadonlyArray<{ value: Protocol; label: string; hint: string }> = [
  { value: 'smtps', label: 'SMTPS', hint: 'submission' },
  { value: 'imap', label: 'IMAP', hint: 'mailbox read' },
];

interface MailboxDetailLite {
  senders?: Array<{ address: string; default_for_mailbox: number; disabled_at: string | null }>;
}

export function IssueCredentialDialog({
  mailboxId,
  defaultUsername,
}: {
  mailboxId: string;
  /** Optional preset for the username — typically the mailbox's default sender. */
  defaultUsername?: string;
}) {
  const [open, setOpen] = useState(false);
  const [protocol, setProtocol] = useState<Protocol>('smtps');
  const [username, setUsername] = useState('');
  const [reveal, setReveal] = useState<{ username: string; plaintext: string } | null>(null);

  // Pull the mailbox detail so we can offer a "use default sender" quick-fill
  // when the caller didn't supply a defaultUsername explicitly. Detail rows
  // are usually already cached (MailboxDetail mounts this dialog).
  const detail = useAdminQuery<MailboxDetailLite>(
    mailboxKeys.detail(mailboxId),
    `/api/admin/mailboxes/${mailboxId}`,
    { enabled: open },
  );
  const defaultSenderAddress =
    defaultUsername ??
    detail.data?.senders?.find((s) => s.default_for_mailbox && !s.disabled_at)?.address ??
    null;

  const issue = useAdminMutation<
    { id: string; plaintext: string },
    { protocol: Protocol; username: string }
  >(
    (vars) => ({
      path: `/api/admin/mailboxes/${mailboxId}/credentials`,
      method: 'POST',
      body: { protocol: vars.protocol, username: vars.username },
    }),
    {
      invalidateKeys: [credentialKeys.all, mailboxKeys.detail(mailboxId)],
      silent: true,
    },
  );

  const reset = () => {
    setProtocol('smtps');
    setUsername('');
    issue.reset();
  };

  const trimmed = username.trim();
  const canSubmit = trimmed.length > 0 && !issue.isPending;
  const showDefaultButton =
    defaultSenderAddress != null && defaultSenderAddress !== trimmed && trimmed.length === 0;

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
          <Button>Add credential</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Issue mailbox credential</DialogTitle>
            <DialogDescription>
              Mints a password for SMTPS submission or IMAP read against this mailbox. The plaintext
              is shown once; Polaris stores only a bcrypt hash.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Protocol</Label>
              <div className="mt-1">
                <SegmentedControl<Protocol>
                  ariaLabel="Protocol"
                  size="sm"
                  options={PROTOCOL_OPTIONS.map((o) => ({
                    value: o.value,
                    label: <span className="font-mono">{o.label}</span>,
                    hint: o.hint,
                  }))}
                  value={protocol}
                  onChange={setProtocol}
                />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between">
                <Label htmlFor="cred-user">Username</Label>
                {showDefaultButton ? (
                  <Button
                    variant="link"
                    size="sm"
                    type="button"
                    onClick={() => setUsername(defaultSenderAddress!)}
                    className="h-auto p-0 text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
                  >
                    Use default sender
                  </Button>
                ) : null}
              </div>
              <Input
                id="cred-user"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={defaultSenderAddress ?? 'e.g. noreply@acme.example'}
                autoComplete="off"
                spellCheck={false}
                className="mt-1"
              />
              <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                Tip: use the address operators expect to log in with.
              </p>
              {trimmed ? (
                <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                  Will issue an <span className="font-mono">{protocol}</span> credential{' '}
                  <span className="font-mono">{trimmed}</span> against this mailbox.
                </p>
              ) : null}
            </div>
            <ErrorText error={issue.error} />
          </div>
          <DialogFooter>
            <Button
              onClick={async () => {
                const r = await issue.mutateAsync({
                  protocol,
                  username: trimmed,
                });
                if (r?.plaintext) {
                  setReveal({ username: trimmed, plaintext: r.plaintext });
                }
                setOpen(false);
                reset();
              }}
              disabled={!canSubmit}
            >
              {issue.isPending ? 'Issuing…' : 'Issue credential'}
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
