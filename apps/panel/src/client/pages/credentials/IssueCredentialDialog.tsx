// Issue dialog for the unified mailbox-credential model.
//
// Type-discriminated form:
//   * imap — requires a receiver pick; result is USER + PASS
//   * smtp — mailbox-scoped, no receiver; result is USER + PASS
//   * rest — bearer token; result is a `pmtk_<kid>.<secret>` single string
//
// MCP and CLI credential types exist in the API but are hidden from the
// UI per the cred-refactor plan ("storage + verifier only — no UI").
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { SecretRevealDialog } from '../../components/SecretRevealDialog.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { credentialKeys, mailboxKeys } from '../../queryKeys.js';
import { ErrorText } from '../../components/ErrorText.js';

type CredentialType = 'imap' | 'smtp' | 'rest';

const TYPE_OPTIONS: ReadonlyArray<{ value: CredentialType; label: string; hint: string }> = [
  { value: 'smtp', label: 'SMTP', hint: 'mailbox-scoped submission (any sender)' },
  { value: 'imap', label: 'IMAP', hint: 'bound to one receiver for mailbox reads' },
  { value: 'rest', label: 'REST', hint: 'bearer token for email-over-REST' },
];

interface ReceiverLite {
  id: string;
  address_pattern: string;
  enabled: number;
  domain_id: string;
}

interface MailboxDetailLite {
  receivers?: ReceiverLite[];
}

type IssueRequest = {
  type: CredentialType;
  display_name?: string;
  receiver_id?: string;
};

type IssueResponse = {
  id: string;
  type: CredentialType;
  prefix: string;
  username?: string;
  password?: string;
  key_id?: string;
  key_secret?: string;
  bearer?: string;
};

interface Revealed {
  type: CredentialType;
  username?: string;
  password?: string;
  bearer?: string;
}

export function IssueCredentialDialog({ mailboxId }: { mailboxId: string }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<CredentialType>('smtp');
  const [displayName, setDisplayName] = useState('');
  const [receiverId, setReceiverId] = useState<string>('');
  const [revealed, setRevealed] = useState<Revealed | null>(null);

  // Pull the mailbox detail so IMAP issuance can offer a receiver
  // picker. Cached by MailboxDetail already in the common path.
  const detail = useAdminQuery<MailboxDetailLite>(
    mailboxKeys.detail(mailboxId),
    `/api/admin/mailboxes/${mailboxId}`,
    { enabled: open },
  );
  const activeReceivers = (detail.data?.receivers ?? []).filter((r) => r.enabled);

  const issue = useAdminMutation<IssueResponse, IssueRequest>(
    (vars) => ({
      path: `/api/admin/mailboxes/${mailboxId}/credentials`,
      method: 'POST',
      body: { ...vars },
    }),
    {
      invalidateKeys: [credentialKeys.all, mailboxKeys.detail(mailboxId)],
      silent: true,
    },
  );

  const reset = () => {
    setType('smtp');
    setDisplayName('');
    setReceiverId('');
    issue.reset();
  };

  const canSubmit = !issue.isPending && (type !== 'imap' || receiverId.length > 0);

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
          <Button size="sm">Add credential</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Issue mailbox credential</DialogTitle>
            <DialogDescription>
              Mints an IMAP, SMTP, or REST credential against this mailbox. The plaintext is shown
              once; Polaris stores only the hash.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="cred-type">Type</Label>
              <Select value={type} onValueChange={(v) => setType(v as CredentialType)}>
                <SelectTrigger id="cred-type" className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      <span className="font-mono">{opt.label}</span>
                      <span className="ml-2 text-xs text-[var(--color-muted-foreground)]">
                        {opt.hint}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {type === 'imap' ? (
              <div>
                <Label htmlFor="cred-receiver">Receiver</Label>
                <Select value={receiverId} onValueChange={setReceiverId}>
                  <SelectTrigger id="cred-receiver" className="mt-1">
                    <SelectValue placeholder="Select a receiver…" />
                  </SelectTrigger>
                  <SelectContent>
                    {activeReceivers.length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-[var(--color-muted-foreground)]">
                        No enabled receivers on this mailbox.
                      </div>
                    ) : (
                      activeReceivers.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          <span className="font-mono">{r.address_pattern}</span>
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                  IMAP credentials filter mail to a single receiver.
                </p>
              </div>
            ) : null}

            <div>
              <Label htmlFor="cred-name">Display name (optional)</Label>
              <Input
                id="cred-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g. apple-mail laptop"
                autoComplete="off"
                spellCheck={false}
                className="mt-1"
              />
              <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                Human label shown on the credentials list — does not affect auth.
              </p>
            </div>

            <ErrorText error={issue.error} />
          </div>
          <DialogFooter>
            <Button
              onClick={async () => {
                const body: IssueRequest = { type };
                if (displayName.trim()) body.display_name = displayName.trim();
                if (type === 'imap') body.receiver_id = receiverId;
                const r = await issue.mutateAsync(body);
                if (r) {
                  setRevealed({
                    type: r.type,
                    username: r.username,
                    password: r.password,
                    bearer: r.bearer,
                  });
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
        open={revealed != null}
        onOpenChange={(o) => !o && setRevealed(null)}
        title={
          revealed?.type === 'rest'
            ? 'REST token issued'
            : revealed?.type === 'imap'
              ? 'IMAP credential issued'
              : 'SMTP credential issued'
        }
        secretLabel={revealed?.type === 'rest' ? 'Bearer token' : 'Password'}
        secret={(revealed?.type === 'rest' ? revealed?.bearer : revealed?.password) ?? null}
        note={
          revealed?.type === 'rest'
            ? 'Use this as the Authorization: Bearer value. Polaris stores only the hash — there is no way to retrieve this value again.'
            : `Username: ${revealed?.username ?? ''}. Use this for IMAP/SMTP login. Polaris stores only the bcrypt hash — there is no way to retrieve this value again.`
        }
      />
    </>
  );
}
