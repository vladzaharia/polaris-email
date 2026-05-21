// Webhook sub detail — edit URL/events, pause, fire a synthetic test event,
// or delete the subscription. Delete goes through the shared destructive
// dialog because the subscription's history (event log, signing secret
// hashes) goes with it.
//
// Tabs:
//  - "Configuration" hosts the edit form (default).
//  - "Failed deliveries" lists this sub's active DLQ entries (non-dropped,
//    non-replayed) with per-row Replay + Drop actions. Mirrors the global
//    DLQ browser but scoped via `?webhook_sub_id=<id>`.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { PageCard } from '../../layouts/PageCard.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Switch } from '../../components/ui/switch.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Badge } from '../../components/ui/badge.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { DestructiveActionDialog } from '../../components/DestructiveActionDialog.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorText } from '../../components/ErrorText.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { dlqKeys, webhookKeys } from '../../queryKeys.js';
import { formatDate, formatRelative } from '../../lib/format.js';

interface SubRow {
  id: string;
  url: string;
  events: string;
  paused_at: string | null;
  mailbox_id: string;
}

interface DlqRow {
  id: string;
  message_id: string | null;
  webhook_sub_id: string;
  payload_sha256: string;
  last_status_code: number | null;
  last_error: string | null;
  attempts: number;
  dlq_at: string;
  replayed_at: string | null;
  dropped_at: string | null;
}

function statusBadgeVariant(code: number | null): 'destructive' | 'warning' | 'outline' {
  if (code == null) return 'outline';
  if (code >= 500) return 'destructive';
  if (code >= 400) return 'warning';
  return 'outline';
}

interface FailedDeliveriesTabProps {
  subId: string;
}

function FailedDeliveriesTab({ subId }: FailedDeliveriesTabProps) {
  const qc = useQueryClient();
  const [dropTarget, setDropTarget] = useState<DlqRow | null>(null);

  const q = useAdminQuery<{ data: DlqRow[] }>(
    dlqKeys.bySub(subId),
    `/api/admin/webhook-dlq?webhook_sub_id=${encodeURIComponent(subId)}`,
    { staleTime: 30_000 },
  );

  const invalidate: ReadonlyArray<readonly unknown[]> = [dlqKeys.all, webhookKeys.detail(subId)];

  const replay = useAdminMutation<unknown, { id: string }>(
    (vars) => ({ path: `/api/admin/webhook-dlq/${vars.id}/replay`, method: 'POST' }),
    { invalidateKeys: invalidate, successMessage: 'DLQ entry replayed.' },
  );
  const drop = useAdminMutation<unknown, { id: string }>(
    (vars) => ({ path: `/api/admin/webhook-dlq/${vars.id}/drop`, method: 'POST' }),
    { invalidateKeys: invalidate, successMessage: 'DLQ entry dropped.' },
  );

  if (q.isLoading) {
    return <Skeleton className="h-32 w-full" />;
  }
  if (q.error) {
    return <ErrorText error={q.error} />;
  }

  const rows = q.data?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {rows.length} active DLQ {rows.length === 1 ? 'entry' : 'entries'}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void qc.invalidateQueries({ queryKey: dlqKeys.list() });
            void qc.invalidateQueries({ queryKey: dlqKeys.bySub(subId) });
          }}
        >
          Refresh
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No failed deliveries."
          icon={<CheckCircle2 className="h-6 w-6" aria-hidden />}
        />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <caption className="sr-only">
              Active DLQ entries for this webhook subscription with per-row Replay or Drop actions.
            </caption>
            <TableHeader>
              <TableRow>
                <TableHead>Age</TableHead>
                <TableHead>Last status</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Last error</TableHead>
                <TableHead>Message</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-xs" title={formatDate(r.dlq_at)}>
                    {formatRelative(r.dlq_at)}
                  </TableCell>
                  <TableCell>
                    {r.last_status_code != null ? (
                      <Badge variant={statusBadgeVariant(r.last_status_code)}>
                        {r.last_status_code}
                      </Badge>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>{r.attempts}</TableCell>
                  <TableCell
                    className="max-w-[24rem] truncate font-mono text-xs"
                    title={r.last_error ?? ''}
                  >
                    {r.last_error ?? '—'}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {r.message_id ? (
                      <Link to="/messages/$id" params={{ id: r.message_id }} className="underline">
                        {r.message_id.slice(0, 10)}…
                      </Link>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => replay.mutate({ id: r.id })}
                        disabled={replay.isPending}
                      >
                        Replay
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => setDropTarget(r)}
                        disabled={drop.isPending}
                      >
                        Drop
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <DestructiveActionDialog
        open={dropTarget != null}
        onOpenChange={(o) => !o && setDropTarget(null)}
        action="Drop DLQ entry"
        name={dropTarget?.id}
        blastRadius={[
          'Drops this delivery permanently — the downstream consumer will never see this event',
          'The associated message row is not affected',
        ]}
        reversible={false}
        confirmLabel="Drop"
        onConfirm={async () => {
          if (!dropTarget) return;
          await drop.mutateAsync({ id: dropTarget.id });
          setDropTarget(null);
        }}
        isPending={drop.isPending}
      />
    </div>
  );
}

export function WebhookSubDetail() {
  const { id } = useParams({ from: '/webhook-subs/$id' });
  const navigate = useNavigate();
  const q = useAdminQuery<SubRow>(webhookKeys.detail(id), `/api/admin/webhook-subs/${id}`);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState('');
  const [paused, setPaused] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (q.data) {
      setUrl(q.data.url);
      setEvents(q.data.events);
      setPaused(q.data.paused_at != null);
    }
  }, [q.data]);

  const patch = useAdminMutation<unknown, Record<string, unknown>>(
    (vars) => ({ path: `/api/admin/webhook-subs/${id}`, method: 'PATCH', body: vars }),
    { invalidateKeys: [webhookKeys.detail(id)] },
  );
  const test = useAdminMutation<unknown, undefined>(
    () => ({
      path: `/api/admin/webhook-subs/${id}/test`,
      method: 'POST',
    }),
    { successMessage: 'Test event sent.' },
  );
  const remove = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/webhook-subs/${id}`, method: 'DELETE' }),
    { invalidateKeys: [webhookKeys.all], successMessage: 'Subscription deleted.' },
  );

  // Breadcrumb back to the parent mailbox — /webhook-subs standalone list
  // was removed in the Stage 4 IA consolidation, so the natural up-link is
  // the mailbox detail page (which now hosts the webhook table inline).
  const breadcrumbs = [
    { label: 'Mailboxes', to: '/mailboxes' },
    q.data?.mailbox_id
      ? { label: 'Mailbox', to: `/mailboxes/${q.data.mailbox_id}` }
      : { label: 'Mailboxes' },
    { label: q.data?.url ?? id },
  ];
  if (q.isLoading) {
    return (
      <PageCard title="Webhook subscription" breadcrumbs={breadcrumbs} decorative>
        <Skeleton className="h-32 w-full" />
      </PageCard>
    );
  }
  if (q.error || !q.data) {
    return (
      <PageCard title="Webhook subscription" breadcrumbs={breadcrumbs} decorative>
        <ErrorText error={q.error ?? 'Not found.'} />
      </PageCard>
    );
  }

  let eventList: string[] = [];
  try {
    eventList = JSON.parse(events || '[]');
  } catch {
    eventList = [];
  }

  return (
    <PageCard title="Webhook subscription" breadcrumbs={breadcrumbs} description={id} decorative>
      <Tabs defaultValue="config">
        <TabsList>
          <TabsTrigger value="config">Configuration</TabsTrigger>
          <TabsTrigger value="dlq">Failed deliveries</TabsTrigger>
        </TabsList>

        <TabsContent value="config">
          <div className="max-w-xl space-y-4">
            <div>
              <Label htmlFor="url">Target URL</Label>
              <Input id="url" value={url} onChange={(e) => setUrl(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="events">Events (JSON array)</Label>
              <Input id="events" value={events} onChange={(e) => setEvents(e.target.value)} />
              <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                Current: {eventList.join(', ') || '(none)'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={paused} onCheckedChange={setPaused} id="paused" />
              <Label htmlFor="paused">Paused</Label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() =>
                  patch.mutate({
                    url,
                    events: eventList,
                    paused,
                  })
                }
                disabled={patch.isPending}
              >
                {patch.isPending ? 'Saving…' : 'Save'}
              </Button>
              <Button
                variant="outline"
                onClick={() => test.mutate(undefined)}
                disabled={test.isPending}
              >
                {test.isPending ? 'Testing…' : 'Send test event'}
              </Button>
              <Button
                variant="destructive"
                onClick={() => setConfirmDelete(true)}
                disabled={remove.isPending}
              >
                Delete subscription
              </Button>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="dlq">
          <FailedDeliveriesTab subId={id} />
        </TabsContent>
      </Tabs>

      <DestructiveActionDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        action="Delete webhook subscription"
        name={q.data.url}
        blastRadius={[
          'No further events will be delivered to this URL',
          'Receivers that route to this subscription will fail until rebound',
          'DLQ entries already queued for this subscription will be dropped',
        ]}
        reversible={false}
        typedConfirmation={id}
        confirmLabel="Delete subscription"
        onConfirm={async () => {
          await remove.mutateAsync(undefined);
          setConfirmDelete(false);
          if (q.data?.mailbox_id) {
            void navigate({ to: '/mailboxes/$id', params: { id: q.data.mailbox_id } });
          } else {
            void navigate({ to: '/mailboxes' });
          }
        }}
        isPending={remove.isPending}
      />
    </PageCard>
  );
}
