// Daemon detail — rotate (one-shot secret modal) + deregister.
import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { PageCard } from '../../layouts/PageCard.js';
import { Button } from '../../components/ui/button.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Badge } from '../../components/ui/badge.js';
import { CodeBlock } from '../../components/CodeBlock.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';

interface DaemonRow {
  id: string;
  name: string;
  last_seen_at: string | null;
  created_at: string;
  disabled_at: string | null;
}

export function DaemonDetail() {
  const { id } = useParams({ from: '/daemons/$id' });
  const q = useAdminQuery<DaemonRow>(['daemon', id], `/api/admin/daemons/${id}`);
  const [rotated, setRotated] = useState<string | null>(null);
  const [confirmDereg, setConfirmDereg] = useState(false);
  const rotate = useAdminMutation<{ hmac_key: string }, undefined>(() => ({
    path: `/api/admin/daemons/${id}/rotate`,
    method: 'POST',
  }));
  const dereg = useAdminMutation<unknown, undefined>(() => ({
    path: `/api/admin/daemons/${id}`,
    method: 'DELETE',
  }));

  if (q.isLoading) {
    return (
      <PageCard title="Daemon">
        <Skeleton className="h-32 w-full" />
      </PageCard>
    );
  }
  if (q.error || !q.data) {
    return (
      <PageCard title="Daemon">
        <p className="text-sm text-[var(--color-destructive)]">
          {q.error?.message ?? 'Not found.'}
        </p>
      </PageCard>
    );
  }
  const d = q.data;

  return (
    <PageCard title={d.name} description={`Last seen: ${d.last_seen_at ?? 'never'}`} decorative>
      <div className="flex flex-wrap items-center gap-2">
        {d.disabled_at ? (
          <Badge variant="destructive">disabled</Badge>
        ) : (
          <Badge variant="success">active</Badge>
        )}
        <Button
          size="sm"
          onClick={async () => {
            const r = await rotate.mutateAsync(undefined);
            setRotated(r.hmac_key);
          }}
          disabled={rotate.isPending}
        >
          {rotate.isPending ? 'Rotating…' : 'Rotate HMAC key'}
        </Button>
        <Button size="sm" variant="destructive" onClick={() => setConfirmDereg(true)}>
          Deregister
        </Button>
      </div>

      <Dialog open={rotated != null} onOpenChange={(o) => !o && setRotated(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New HMAC key</DialogTitle>
            <DialogDescription>One-time view. Copy it now.</DialogDescription>
          </DialogHeader>
          {rotated ? <CodeBlock code={rotated} /> : null}
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDereg} onOpenChange={setConfirmDereg}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deregister {d.name}?</DialogTitle>
            <DialogDescription>
              This will soft-disable the daemon. The HMAC key continues to be rejected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDereg(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                await dereg.mutateAsync(undefined);
                setConfirmDereg(false);
              }}
              disabled={dereg.isPending}
            >
              {dereg.isPending ? 'Deregistering…' : 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageCard>
  );
}
