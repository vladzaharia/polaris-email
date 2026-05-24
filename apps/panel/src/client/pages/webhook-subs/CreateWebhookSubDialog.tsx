// Extracted from webhook-subs/List.tsx so MailboxDetail can mount the
// "Add webhook" dialog inline. Mailbox is fixed by prop (no picker) — every
// caller is mailbox-scoped.
//
// UX: target URL gets an icon prefix that switches with the tailnet toggle
// (Globe2 vs Network); placeholders surface the expected URL shape per
// mode; event checkboxes live under a "Message events" section heading so
// future event families slot in without re-laying-out the grid.
import { useState } from 'react';
import { Globe2, Network } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Switch } from '../../components/ui/switch.js';
import { Checkbox } from '../../components/ui/checkbox.js';
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
import { useAdminMutation } from '../../hooks/useAdminApi.js';
import { mailboxKeys, webhookKeys } from '../../queryKeys.js';
import { ErrorText } from '../../components/ErrorText.js';
import { FormField } from '../../components/FormField.js';

const EVENT_OPTIONS = [
  'message.received',
  'message.delivered',
  'message.bounced',
  'message.failed',
] as const;

export function CreateWebhookSubDialog({ mailboxId }: { mailboxId: string }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [tailnet, setTailnet] = useState(false);
  const [selectedEvents, setSelectedEvents] = useState<string[]>(['message.received']);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

  const create = useAdminMutation<
    { id: string; secret: string },
    { mailbox_id: string; url: string; kind: 'external' | 'tailnet'; events: string[] }
  >((vars) => ({ path: '/api/admin/webhook-subs', method: 'POST', body: vars }), {
    invalidateKeys: [webhookKeys.all, mailboxKeys.detail(mailboxId)],
    silent: true,
  });

  const reset = () => {
    setUrl('');
    setTailnet(false);
    setSelectedEvents(['message.received']);
    create.reset();
  };

  const canSubmit = url.trim().length > 0 && selectedEvents.length > 0 && !create.isPending;
  const Icon = tailnet ? Network : Globe2;
  const placeholder = tailnet
    ? 'https://my-host.tailXXXX.ts.net/webhook'
    : 'https://hooks.example.com/polaris';

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
          <Button size="sm">Add webhook</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add webhook subscription</DialogTitle>
            <DialogDescription>
              Polaris fans out signed envelopes for the events you pick. Tailnet targets must
              resolve to <code className="font-mono">*.ts.net</code> from inside the bridge tailnet.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <FormField
              id="wh-url"
              label="Target URL"
              required
              helper={
                <>
                  HTTPS required. Will sign deliveries with HMAC-SHA256 over{' '}
                  <span className="font-mono">polaris-webhook</span>.
                </>
              }
            >
              <div className="relative">
                <span
                  className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-[var(--color-muted-foreground)]"
                  aria-hidden
                >
                  <Icon className="h-4 w-4" />
                </span>
                <Input
                  id="wh-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder={placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  className="pl-8"
                />
              </div>
            </FormField>
            <div className="flex items-center gap-2">
              <Switch id="wh-tn" checked={tailnet} onCheckedChange={setTailnet} />
              <Label htmlFor="wh-tn">Tailnet target (*.ts.net)</Label>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <Label className="text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">
                  Message events
                </Label>
                <span className="text-[10px] text-[var(--color-muted-foreground)]">
                  {selectedEvents.length} selected
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {EVENT_OPTIONS.map((ev) => {
                  const checked = selectedEvents.includes(ev);
                  const id = `wh-evt-${ev}`;
                  return (
                    <label
                      key={ev}
                      htmlFor={id}
                      className="flex cursor-pointer items-center gap-2 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:border-[var(--color-primary)]"
                    >
                      <Checkbox
                        id={id}
                        checked={checked}
                        onCheckedChange={(c) =>
                          setSelectedEvents((prev) =>
                            c === true ? [...prev, ev] : prev.filter((x) => x !== ev),
                          )
                        }
                      />
                      <span className="font-mono text-xs">{ev}</span>
                    </label>
                  );
                })}
              </div>
            </div>
            <ErrorText error={create.error} />
          </div>
          <DialogFooter>
            <Button
              size="sm"
              onClick={async () => {
                const r = await create.mutateAsync({
                  mailbox_id: mailboxId,
                  url: url.trim(),
                  kind: tailnet ? 'tailnet' : 'external',
                  events: selectedEvents,
                });
                if (r?.secret) {
                  setRevealedSecret(r.secret);
                }
                setOpen(false);
                reset();
              }}
              disabled={!canSubmit}
            >
              {create.isPending ? 'Creating…' : 'Create subscription'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SecretRevealDialog
        open={revealedSecret != null}
        onOpenChange={(o) => !o && setRevealedSecret(null)}
        title="Webhook subscription created"
        secretLabel="Signing secret"
        secret={revealedSecret}
        note="Use this secret to verify the X-Polaris-Sig header on incoming webhook requests. Polaris stores only the hash — there is no way to retrieve this value again."
      />
    </>
  );
}
