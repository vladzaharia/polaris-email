// Modal version of the test-send flow. Mounted inline on MailboxDetail so
// operators don't have to navigate to a separate /test-send page just to fire
// off a quick smoke send. Streams the message lifecycle via SSE just like the
// standalone form.
import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
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
import { Badge } from '../../components/ui/badge.js';
import { AddressCombobox } from '../../components/AddressCombobox.js';
import { useAllSenderAddresses } from '../../hooks/useAllSenderAddresses.js';
import { useStream } from '../../hooks/useStream.js';
import { apiFetch, ApiError } from '../../lib/api.js';

interface SenderRow {
  id: string;
  address: string;
}

const TIMELINE_ORDER = ['queued', 'sending', 'sent', 'delivered'];

export function SendTestDialog({
  mailboxId,
  senders,
}: {
  mailboxId: string;
  senders: SenderRow[];
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('Polaris test message');
  const [text, setText] = useState('Hello from the panel.');
  const [messageId, setMessageId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stream = useStream<{ status?: string }>(
    messageId ? `/api/test-send/${messageId}/stream` : null,
  );

  const senderAddrs = useAllSenderAddresses();
  // The 'To' combobox supports comma-separated input; we still surface known
  // mailbox addresses (useful for sender→sender test sends within an org).
  const toSuggestions = [{ label: 'Mailbox senders', addresses: senderAddrs.data }] as const;

  // Reset transient state when the dialog closes so a repeat-open feels fresh.
  // mailboxId/senders come from props — we never need to reset those.
  const reset = () => {
    setFrom('');
    setTo('');
    setSubject('Polaris test message');
    setText('Hello from the panel.');
    setMessageId(null);
    setError(null);
  };

  const submit = async (): Promise<void> => {
    setError(null);
    setMessageId(null);
    setSubmitting(true);
    try {
      const r = await apiFetch<{ message_id?: string }>('/api/test-send', {
        method: 'POST',
        body: JSON.stringify({
          from,
          to: to
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          subject,
          text,
        }),
      });
      if (r.body?.message_id) {
        setMessageId(r.body.message_id);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  // Suppress unused-var warning when there are no active senders yet —
  // the dialog still mounts so operators can see the empty-state guidance.
  void mailboxId;

  const seen = new Set<string>(stream.events.map((e) => e.event));

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Send test
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a test message</DialogTitle>
          <DialogDescription>
            Fires through the real outbound pipeline and streams lifecycle events back.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div>
            <Label>From (sender address)</Label>
            <Select value={from || undefined} onValueChange={setFrom}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Pick a sender" />
              </SelectTrigger>
              <SelectContent>
                {senders.map((s) => (
                  <SelectItem key={s.id} value={s.address}>
                    {s.address}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="st-to">To (comma-separated)</Label>
            <AddressCombobox
              id="st-to"
              value={to}
              onChange={setTo}
              suggestions={toSuggestions}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="st-subj">Subject</Label>
            <Input id="st-subj" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="st-text">Text body</Label>
            <Textarea
              id="st-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              className="mt-1 font-mono"
            />
          </div>
          {error ? <p className="text-sm text-[var(--color-destructive)]">{error}</p> : null}

          {messageId ? (
            <section className="mt-2">
              <h3 className="mb-2 text-sm font-medium">Lifecycle</h3>
              <p className="mb-2 text-xs text-[var(--color-muted-foreground)]">
                message_id: <code>{messageId}</code>
              </p>
              <ol className="space-y-1">
                {TIMELINE_ORDER.map((step) => {
                  const reached =
                    seen.has(step) ||
                    TIMELINE_ORDER.indexOf(step) <
                      Math.max(...TIMELINE_ORDER.map((s, i) => (seen.has(s) ? i : -1)));
                  return (
                    <li key={step} className="flex items-center gap-2 text-sm">
                      {reached ? (
                        <Badge variant="success">✓</Badge>
                      ) : (
                        <Badge variant="outline">…</Badge>
                      )}
                      <span>{step}</span>
                    </li>
                  );
                })}
                {seen.has('failed') ? (
                  <li className="flex items-center gap-2 text-sm">
                    <Badge variant="destructive">×</Badge>failed
                  </li>
                ) : null}
                {seen.has('bounced') ? (
                  <li className="flex items-center gap-2 text-sm">
                    <Badge variant="destructive">×</Badge>bounced
                  </li>
                ) : null}
              </ol>
              <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
                stream: {stream.status}
              </p>
            </section>
          ) : null}
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={submitting || !from || !to}>
            {submitting ? 'Sending…' : 'Send test'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
