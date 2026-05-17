// Bridges list + register form.
//
// Registration mints a fresh HMAC key — the schema stores only the hash, so
// the response is the single chance to capture the plaintext key.
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { PageCard } from '../../layouts/PageCard.js';
import { PaginatedTable } from '../../components/PaginatedTable.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { SecretRevealDialog } from '../../components/SecretRevealDialog.js';
import { ErrorText } from '../../components/ErrorText.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { bridgeKeys } from '../../queryKeys.js';
import { formatDate, formatRelative } from '../../lib/format.js';

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
      {q.error ? (
        <ErrorText error={q.error} />
      ) : (
        <PaginatedTable<BridgeRow>
          caption="Registered on-prem bridges and their last heartbeat."
          loading={q.isLoading}
          rows={q.data?.data ?? []}
          empty="No bridges registered."
          rowKey={(d) => d.id}
          columns={[
            {
              key: 'name',
              header: 'Name',
              cell: (d) => (
                <Link to="/bridges/$id" params={{ id: d.id }} className="underline">
                  {d.name}
                </Link>
              ),
            },
            {
              key: 'last_seen_at',
              header: 'Last seen',
              className: 'text-xs',
              cell: (d) => (
                <span title={d.last_seen_at ? formatDate(d.last_seen_at) : undefined}>
                  {formatRelative(d.last_seen_at)}
                </span>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (d) => (
                <StatusBadge kind="bridge" value={d.disabled_at ? 'deregistered' : 'registered'} />
              ),
            },
          ]}
        />
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
