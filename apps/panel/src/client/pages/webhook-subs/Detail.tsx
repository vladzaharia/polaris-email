// Webhook sub detail — edit URL/events, pause, fire a synthetic test event,
// or delete the subscription. Delete goes through the shared destructive
// dialog because the subscription's history (event log, signing secret
// hashes) goes with it.
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { PageCard } from '../../layouts/PageCard.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Switch } from '../../components/ui/switch.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { DestructiveActionDialog } from '../../components/DestructiveActionDialog.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { webhookKeys } from '../../queryKeys.js';

interface SubRow {
  id: string;
  url: string;
  events: string;
  paused_at: string | null;
  mailbox_id: string;
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

  const breadcrumbs = [
    { label: 'Webhook subs', to: '/webhook-subs' },
    { label: q.data?.url ?? id },
  ];
  if (q.isLoading) {
    return (
      <PageCard title="Webhook subscription" breadcrumbs={breadcrumbs}>
        <Skeleton className="h-32 w-full" />
      </PageCard>
    );
  }
  if (q.error || !q.data) {
    return (
      <PageCard title="Webhook subscription" breadcrumbs={breadcrumbs}>
        <p className="text-sm text-[var(--color-destructive)]">
          {q.error?.message ?? 'Not found.'}
        </p>
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
          void navigate({ to: '/webhook-subs' });
        }}
        isPending={remove.isPending}
      />
    </PageCard>
  );
}
