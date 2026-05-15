// Bridges list + register form.
//
// Registration mints a fresh HMAC key — the schema stores only the hash, so
// the response is the single chance to capture the plaintext key.
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
import { StatusBadge } from '../../components/StatusBadge.js';
import { SecretRevealDialog } from '../../components/SecretRevealDialog.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { bridgeKeys } from '../../queryKeys.js';

interface BridgeRow {
  id: string;
  name: string;
  last_seen_at: string | null;
  created_at: string;
  disabled_at: string | null;
}

export function BridgesList() {
  const q = useAdminQuery<{ data: BridgeRow[] }>(bridgeKeys.list(), '/api/admin/bridges');
  const [name, setName] = useState('');
  const [registered, setRegistered] = useState<{ name: string; hmac_key: string } | null>(null);
  // Registration is silent — the new HMAC key is shown via SecretRevealDialog.
  const register = useAdminMutation<{ id: string; hmac_key: string }, { name: string }>(
    (vars) => ({ path: '/api/admin/bridges', method: 'POST', body: vars }),
    { invalidateKeys: [bridgeKeys.all], silent: true },
  );
  return (
    <PageCard title="Bridges" description="On-prem submission/IMAP bridges." decorative>
      <div className="mb-6 flex items-end gap-2">
        <div className="flex-1 max-w-xs">
          <Label htmlFor="bn">Register a bridge</Label>
          <Input
            id="bn"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="bridge-name"
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
        <p className="text-sm text-[var(--color-muted-foreground)]">No bridges registered.</p>
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
                  <Link to="/bridges/$id" params={{ id: d.id }} className="underline">
                    {d.name}
                  </Link>
                </TableCell>
                <TableCell className="text-xs">{d.last_seen_at ?? '—'}</TableCell>
                <TableCell>
                  <StatusBadge
                    kind="bridge"
                    value={d.disabled_at ? 'deregistered' : 'registered'}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <SecretRevealDialog
        open={registered != null}
        onOpenChange={(o) => !o && setRegistered(null)}
        title={`Bridge ${registered?.name ?? ''} registered`}
        secretLabel="HMAC key"
        secret={registered?.hmac_key ?? null}
        note="Configure the bridge with this key now. Polaris stores only the hash — there is no way to retrieve this value again."
      />
    </PageCard>
  );
}
