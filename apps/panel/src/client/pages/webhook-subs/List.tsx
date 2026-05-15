// Webhook subs list — mailbox-scoped via GET /v1/admin/webhook-subs.
//
// "Create webhook subscription" mounts a Dialog that POSTs to
// /v1/admin/webhook-subs and, on success, opens SecretRevealDialog with the
// HMAC secret (the schema stores only the hash — this is the only chance to
// capture the plaintext).
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
import { StatusBadge } from '../../components/StatusBadge.js';
import { SecretRevealDialog } from '../../components/SecretRevealDialog.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { mailboxKeys, webhookKeys } from '../../queryKeys.js';

interface MailboxRow {
  id: string;
  name: string;
}
interface SubRow {
  id: string;
  mailbox_id: string;
  url: string;
  kind: string;
  events: string;
  paused_at: string | null;
  created_at: string;
}

const EVENT_OPTIONS = [
  'message.received',
  'message.delivered',
  'message.bounced',
  'message.failed',
] as const;

function CreateWebhookSubDialog({ mailboxes }: { mailboxes: MailboxRow[] }) {
  const [open, setOpen] = useState(false);
  const [mailboxId, setMailboxId] = useState('');
  const [url, setUrl] = useState('');
  const [tailnet, setTailnet] = useState(false);
  const [selectedEvents, setSelectedEvents] = useState<string[]>(['message.received']);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

  const create = useAdminMutation<
    { id: string; secret: string },
    { mailbox_id: string; url: string; kind: 'external' | 'tailnet'; events: string[] }
  >((vars) => ({ path: '/api/admin/webhook-subs', method: 'POST', body: vars }), {
    invalidateKeys: [webhookKeys.all],
    silent: true,
  });

  const reset = () => {
    setMailboxId('');
    setUrl('');
    setTailnet(false);
    setSelectedEvents(['message.received']);
    create.reset();
  };

  const canSubmit =
    !!mailboxId && url.trim().length > 0 && selectedEvents.length > 0 && !create.isPending;

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
          <Button>Create webhook subscription</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create webhook subscription</DialogTitle>
            <DialogDescription>
              Receives signed envelopes for the selected events. Tailnet targets must resolve to{' '}
              <code className="font-mono">*.ts.net</code>.
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
              <Label htmlFor="wh-url">Target URL</Label>
              <Input
                id="wh-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={tailnet ? 'https://host.tailnet.ts.net/webhook' : 'https://…'}
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch id="wh-tn" checked={tailnet} onCheckedChange={setTailnet} />
              <Label htmlFor="wh-tn">Tailnet target (*.ts.net)</Label>
            </div>
            <div>
              <Label>Events</Label>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {EVENT_OPTIONS.map((ev) => {
                  const checked = selectedEvents.includes(ev);
                  return (
                    <label
                      key={ev}
                      className="flex items-center gap-2 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) =>
                          setSelectedEvents((prev) =>
                            e.target.checked ? [...prev, ev] : prev.filter((x) => x !== ev),
                          )
                        }
                      />
                      <span className="font-mono text-xs">{ev}</span>
                    </label>
                  );
                })}
              </div>
            </div>
            {create.error ? (
              <p className="text-sm text-[var(--color-destructive)]">{create.error.message}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
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
              {create.isPending ? 'Creating…' : 'Create'}
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

export function WebhookSubsList() {
  const [mailboxId, setMailboxId] = useState('');
  const mailboxes = useAdminQuery<{ data: MailboxRow[] }>(
    mailboxKeys.list(),
    '/api/admin/mailboxes',
  );
  const path = mailboxId
    ? `/api/admin/webhook-subs?mailbox_id=${mailboxId}`
    : '/api/admin/webhook-subs';
  const q = useAdminQuery<{ data: SubRow[] }>(webhookKeys.list(mailboxId || undefined), path);
  const mailboxList = mailboxes.data?.data ?? [];
  return (
    <PageCard
      title="Webhook subscriptions"
      description="External + tailnet webhook targets."
      decorative
    >
      <div className="mb-4 flex items-end justify-between gap-4">
        <div className="max-w-sm flex-1">
          <Label>Filter by mailbox</Label>
          <Select
            value={mailboxId || 'all'}
            onValueChange={(v) => setMailboxId(v === 'all' ? '' : v)}
          >
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="All mailboxes" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All mailboxes</SelectItem>
              {mailboxList.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <CreateWebhookSubDialog mailboxes={mailboxList} />
      </div>
      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : q.error ? (
        <p className="text-sm text-[var(--color-destructive)]">{q.error.message}</p>
      ) : (q.data?.data ?? []).length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">No webhook subscriptions.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Target URL</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Events</TableHead>
              <TableHead>Mailbox</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(q.data?.data ?? []).map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-mono text-xs">
                  <Link to="/webhook-subs/$id" params={{ id: s.id }} className="underline">
                    {s.url}
                  </Link>
                </TableCell>
                <TableCell>{s.kind}</TableCell>
                <TableCell className="font-mono text-xs">{s.events}</TableCell>
                <TableCell className="font-mono text-xs">{s.mailbox_id}</TableCell>
                <TableCell>
                  <StatusBadge kind="webhook" value={s.paused_at ? 'paused' : 'active'} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PageCard>
  );
}
