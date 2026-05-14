// Webhook sub detail — edit URL/events, pause, fire a synthetic test event.
import { useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { PageCard } from '../../layouts/PageCard.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Switch } from '../../components/ui/switch.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';

interface SubRow {
  id: string;
  url: string;
  events: string;
  paused_at: string | null;
  mailbox_id: string;
}

export function WebhookSubDetail() {
  const { id } = useParams({ from: '/webhook-subs/$id' });
  const q = useAdminQuery<SubRow>(['webhook-sub', id], `/api/admin/webhook-subs/${id}`);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState('');
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (q.data) {
      setUrl(q.data.url);
      setEvents(q.data.events);
      setPaused(q.data.paused_at != null);
    }
  }, [q.data]);

  const patch = useAdminMutation<unknown, Record<string, unknown>>(
    (vars) => ({ path: `/api/admin/webhook-subs/${id}`, method: 'PATCH', body: vars }),
    { invalidateKeys: [['webhook-sub', id]] },
  );
  const test = useAdminMutation<unknown, undefined>(() => ({
    path: `/api/admin/webhook-subs/${id}/test`,
    method: 'POST',
  }));

  if (q.isLoading) {
    return (
      <PageCard title="Webhook subscription">
        <Skeleton className="h-32 w-full" />
      </PageCard>
    );
  }
  if (q.error || !q.data) {
    return (
      <PageCard title="Webhook subscription">
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
    <PageCard title="Webhook subscription" description={id} decorative>
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
        <div className="flex gap-2">
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
        </div>
      </div>
    </PageCard>
  );
}
