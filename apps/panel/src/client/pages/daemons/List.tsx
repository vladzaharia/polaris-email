// Daemons list + register form.
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
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
import { Skeleton } from '../../components/ui/skeleton.js';
import { Badge } from '../../components/ui/badge.js';
import { CodeBlock } from '../../components/CodeBlock.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

export function DaemonsList() {
  const q = useAdminQuery<{ data: DaemonRow[] }>(['daemons'], '/api/admin/daemons');
  const [name, setName] = useState('');
  const [registered, setRegistered] = useState<{ name: string; hmac_key: string } | null>(null);
  const register = useAdminMutation<{ id: string; hmac_key: string }, { name: string }>(
    (vars) => ({ path: '/api/admin/daemons', method: 'POST', body: vars }),
    { invalidateKeys: [['daemons']] },
  );
  return (
    <PageCard title="Daemons" description="On-prem submission/IMAP bridges." decorative>
      <div className="mb-6 flex items-end gap-2">
        <div className="flex-1 max-w-xs">
          <Label htmlFor="dn">Register a daemon</Label>
          <Input
            id="dn"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="daemon-name"
          />
        </div>
        <Button
          onClick={async () => {
            const r = await register.mutateAsync({ name });
            setRegistered({ name, hmac_key: r.hmac_key });
            setName('');
          }}
          disabled={!name || register.isPending}
        >
          {register.isPending ? 'Registering…' : 'Register'}
        </Button>
      </div>
      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : q.error ? (
        <p className="text-sm text-[var(--color-destructive)]">{q.error.message}</p>
      ) : (q.data?.data ?? []).length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">No daemons registered.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Last seen</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(q.data?.data ?? []).map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <Link to="/daemons/$id" params={{ id: d.id }} className="underline">
                    {d.name}
                  </Link>
                </TableCell>
                <TableCell className="text-xs">{d.last_seen_at ?? '—'}</TableCell>
                <TableCell>
                  {d.disabled_at ? (
                    <Badge variant="destructive">disabled</Badge>
                  ) : (
                    <Badge variant="success">active</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={registered != null} onOpenChange={(o) => !o && setRegistered(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Daemon {registered?.name} registered</DialogTitle>
            <DialogDescription>Copy the HMAC key — it&apos;s only shown once.</DialogDescription>
          </DialogHeader>
          {registered ? <CodeBlock code={registered.hmac_key} /> : null}
        </DialogContent>
      </Dialog>
    </PageCard>
  );
}
