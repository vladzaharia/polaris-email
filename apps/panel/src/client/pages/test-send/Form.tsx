// Test-send form. POSTs to the panel-only /api/test-send endpoint (which
// wraps POST /v1/messages with the operator credential) and then opens an SSE
// stream against /api/test-send/:id/stream to render a lifecycle timeline.
import { useState } from 'react';
import { PageCard } from '../../layouts/PageCard.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Label } from '../../components/ui/label.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { useAdminQuery } from '../../hooks/useAdminApi.js';
import { mailboxKeys } from '../../queryKeys.js';
import { useStream } from '../../hooks/useStream.js';
import { Badge } from '../../components/ui/badge.js';
import { apiFetch, ApiError } from '../../lib/api.js';

interface MailboxRow {
  id: string;
  name: string;
}
interface SenderRow {
  id: string;
  address: string;
}

const TIMELINE_ORDER = ['queued', 'sending', 'sent', 'delivered'];

export function TestSendForm() {
  const mailboxes = useAdminQuery<{ data: MailboxRow[] }>(
    mailboxKeys.list(),
    '/api/admin/mailboxes',
  );
  const [mailboxId, setMailboxId] = useState('');
  const detail = useAdminQuery<{ senders: SenderRow[] }>(
    mailboxKeys.detail(mailboxId),
    `/api/admin/mailboxes/${mailboxId}`,
    { enabled: !!mailboxId },
  );

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

  const seen = new Set<string>(stream.events.map((e) => e.event));

  return (
    <PageCard
      title="Test send"
      description="Send a real message and watch its lifecycle stream in."
      decorative
    >
      <div className="grid max-w-2xl gap-3">
        <div>
          <Label>Mailbox</Label>
          <Select value={mailboxId || undefined} onValueChange={setMailboxId}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Pick a mailbox" />
            </SelectTrigger>
            <SelectContent>
              {(mailboxes.data?.data ?? []).map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>From (sender address)</Label>
          <Select value={from || undefined} onValueChange={setFrom} disabled={!mailboxId}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Pick a sender" />
            </SelectTrigger>
            <SelectContent>
              {(detail.data?.senders ?? []).map((s) => (
                <SelectItem key={s.id} value={s.address}>
                  {s.address}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="to">To (comma-separated)</Label>
          <Input id="to" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="subj">Subject</Label>
          <Input id="subj" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="text">Text body</Label>
          <Textarea
            id="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            className="mt-1 font-mono"
          />
        </div>
        <Button onClick={submit} disabled={submitting || !from || !to}>
          {submitting ? 'Sending…' : 'Send test'}
        </Button>
        {error ? <p className="text-sm text-[var(--color-destructive)]">{error}</p> : null}

        {messageId ? (
          <section className="mt-6">
            <h2 className="mb-3 text-xl font-medium">Lifecycle</h2>
            <p className="mb-3 text-xs text-[var(--color-muted-foreground)]">
              message_id: <code>{messageId}</code>
            </p>
            <ol className="space-y-2">
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
            <p className="mt-3 text-xs text-[var(--color-muted-foreground)]">
              stream: {stream.status}
            </p>
          </section>
        ) : null}
      </div>
    </PageCard>
  );
}
