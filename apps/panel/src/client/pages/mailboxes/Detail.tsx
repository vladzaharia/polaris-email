// Mailbox detail — header + four sections (Senders / Receivers / Credentials /
// Webhook subs) + recent Messages. Each section has its own add Dialog.
import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
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
import { Separator } from '../../components/ui/separator.js';
import { Badge } from '../../components/ui/badge.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';

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
  webhook_subs: Array<{ id: string; url: string; events: string; paused_at: string | null }>;
}

interface DomainRow {
  id: string;
  name: string;
}

function AddSenderDialog({ mailboxId }: { mailboxId: string }) {
  const [open, setOpen] = useState(false);
  const [domainId, setDomainId] = useState('');
  const [localPart, setLocalPart] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const domains = useAdminQuery<{ data: DomainRow[] }>(['domains'], '/api/admin/domains');
  const create = useAdminMutation<unknown, Record<string, unknown>>(
    (vars) => ({
      path: `/api/admin/mailboxes/${mailboxId}/senders`,
      method: 'POST',
      body: vars,
    }),
    { invalidateKeys: [['mailbox', mailboxId]] },
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Add sender</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add sender</DialogTitle>
          <DialogDescription>
            Bind a local-part to one of this mailbox&apos;s domains.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Domain</Label>
            <select
              value={domainId}
              onChange={(e) => setDomainId(e.target.value)}
              className="mt-1 block w-full rounded-md border bg-transparent px-3 py-2 text-sm"
            >
              <option value="">Pick a domain</option>
              {(domains.data?.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="lp">Local part</Label>
            <Input id="lp" value={localPart} onChange={(e) => setLocalPart(e.target.value)} />
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={isDefault} onCheckedChange={setIsDefault} id="def" />
            <Label htmlFor="def">Default sender for this mailbox</Label>
          </div>
          {create.error ? (
            <p className="text-sm text-[var(--color-destructive)]">{create.error.message}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            onClick={async () => {
              await create.mutateAsync({
                domain_id: domainId,
                local_part: localPart,
                default_for_mailbox: isDefault,
              });
              setOpen(false);
              setLocalPart('');
              setIsDefault(false);
            }}
            disabled={!domainId || !localPart || create.isPending}
          >
            {create.isPending ? 'Adding…' : 'Add sender'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddReceiverDialog({ mailboxId }: { mailboxId: string }) {
  const [open, setOpen] = useState(false);
  const [domainId, setDomainId] = useState('');
  const [priority, setPriority] = useState(100);
  const [pattern, setPattern] = useState('*');
  const [action, setAction] = useState<'webhook' | 'forward' | 'drop'>('webhook');
  const [webhookSubId, setWebhookSubId] = useState('');
  const [forwardTo, setForwardTo] = useState('');
  const domains = useAdminQuery<{ data: DomainRow[] }>(['domains'], '/api/admin/domains');
  const subs = useAdminQuery<{ data: { id: string; url: string }[] }>(
    ['webhook-subs', mailboxId],
    `/api/admin/webhook-subs?mailbox_id=${mailboxId}`,
  );
  const create = useAdminMutation<unknown, Record<string, unknown>>(
    (vars) => ({
      path: `/api/admin/mailboxes/${mailboxId}/receivers`,
      method: 'POST',
      body: vars,
    }),
    { invalidateKeys: [['mailbox', mailboxId]] },
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Add receiver</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add receiver</DialogTitle>
          <DialogDescription>Address pattern + action.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Domain</Label>
            <select
              value={domainId}
              onChange={(e) => setDomainId(e.target.value)}
              className="mt-1 block w-full rounded-md border bg-transparent px-3 py-2 text-sm"
            >
              <option value="">Pick a domain</option>
              {(domains.data?.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="prio">Priority</Label>
            <Input
              id="prio"
              type="number"
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
            />
          </div>
          <div>
            <Label htmlFor="pat">Address pattern</Label>
            <Input id="pat" value={pattern} onChange={(e) => setPattern(e.target.value)} />
          </div>
          <div>
            <Label>Action</Label>
            <select
              value={action}
              onChange={(e) => setAction(e.target.value as 'webhook' | 'forward' | 'drop')}
              className="mt-1 block w-full rounded-md border bg-transparent px-3 py-2 text-sm"
            >
              <option value="webhook">webhook</option>
              <option value="forward">forward</option>
              <option value="drop">drop</option>
            </select>
          </div>
          {action === 'webhook' ? (
            <div>
              <Label>Webhook subscription</Label>
              <select
                value={webhookSubId}
                onChange={(e) => setWebhookSubId(e.target.value)}
                className="mt-1 block w-full rounded-md border bg-transparent px-3 py-2 text-sm"
              >
                <option value="">Pick one</option>
                {(subs.data?.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.url}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {action === 'forward' ? (
            <div>
              <Label htmlFor="fwd">Forward to</Label>
              <Input id="fwd" value={forwardTo} onChange={(e) => setForwardTo(e.target.value)} />
            </div>
          ) : null}
          {create.error ? (
            <p className="text-sm text-[var(--color-destructive)]">{create.error.message}</p>
          ) : null}
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
  const q = useAdminQuery<MailboxDetailPayload>(['mailbox', id], `/api/admin/mailboxes/${id}`);
  const recent = useAdminQuery<{ data: Array<{ id: string; subject: string; status: string }> }>(
    ['messages-recent', id],
    `/api/messages?mailbox_id=${id}&limit=20`,
  );
  const disableSender = useAdminMutation<unknown, { senderId: string }>(
    (vars) => ({
      path: `/api/admin/mailboxes/${id}/senders/${vars.senderId}`,
      method: 'DELETE',
    }),
    { invalidateKeys: [['mailbox', id]] },
  );

  if (q.isLoading) {
    return (
      <PageCard title="Mailbox">
        <Skeleton className="h-32 w-full" />
      </PageCard>
    );
  }
  if (q.error || !q.data) {
    return (
      <PageCard title="Mailbox">
        <p className="text-sm text-[var(--color-destructive)]">
          {q.error?.message ?? 'Failed to load.'}
        </p>
      </PageCard>
    );
  }
  const d = q.data;

  return (
    <PageCard
      decorative
      title={d.mailbox.name}
      description={d.mailbox.description ?? 'No description.'}
    >
      <div className="space-y-8">
        <section>
          <header className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Senders</h2>
            <AddSenderDialog mailboxId={id} />
          </header>
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
              {d.senders.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-sm text-[var(--color-muted-foreground)]">
                    No senders yet.
                  </TableCell>
                </TableRow>
              ) : (
                d.senders.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>{s.address}</TableCell>
                    <TableCell>
                      {s.default_for_mailbox ? <Badge variant="success">default</Badge> : null}
                    </TableCell>
                    <TableCell>
                      {s.disabled_at ? (
                        <Badge variant="destructive">disabled</Badge>
                      ) : (
                        <Badge variant="success">active</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {s.disabled_at ? null : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => disableSender.mutate({ senderId: s.id })}
                          disabled={disableSender.isPending}
                        >
                          Disable
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </section>

        <Separator />

        <section>
          <header className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Receivers</h2>
            <AddReceiverDialog mailboxId={id} />
          </header>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Priority</TableHead>
                <TableHead>Pattern</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Enabled</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.receivers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-sm text-[var(--color-muted-foreground)]">
                    No receivers yet.
                  </TableCell>
                </TableRow>
              ) : (
                d.receivers.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.priority}</TableCell>
                    <TableCell className="font-mono text-xs">{r.address_pattern}</TableCell>
                    <TableCell>{r.action}</TableCell>
                    <TableCell>{r.enabled ? 'yes' : 'no'}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </section>

        <Separator />

        <section>
          <h2 className="mb-2 text-sm font-semibold">Credentials</h2>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {d.principals.length} principal(s). Manage from the Credentials page.
          </p>
        </section>

        <Separator />

        <section>
          <h2 className="mb-2 text-sm font-semibold">Webhook subscriptions</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>URL</TableHead>
                <TableHead>Events</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.webhook_subs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-sm text-[var(--color-muted-foreground)]">
                    None.
                  </TableCell>
                </TableRow>
              ) : (
                d.webhook_subs.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell className="font-mono text-xs">{w.url}</TableCell>
                    <TableCell className="font-mono text-xs">{w.events}</TableCell>
                    <TableCell>
                      {w.paused_at ? (
                        <Badge variant="secondary">paused</Badge>
                      ) : (
                        <Badge variant="success">active</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </section>

        <Separator />

        <section>
          <h2 className="mb-2 text-sm font-semibold">Recent messages</h2>
          {recent.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (recent.data?.data ?? []).length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">No messages yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Subject</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(recent.data?.data ?? []).map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>{m.subject ?? '(no subject)'}</TableCell>
                    <TableCell>{m.status}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      </div>
    </PageCard>
  );
}
