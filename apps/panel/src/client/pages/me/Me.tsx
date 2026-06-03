// /me — operator identity hub. Combines the previous /settings/account
// (OIDC profile) with the matched operators-row (role, scopes, api-key
// fingerprint, last seen). Audit entries scoped to the current operator's
// email tail the page so an operator can see what they themselves have
// done recently.
//
// One page per operator. The hub does NOT manage other operators —
// that lives behind `polaris-mail operator add` (CLI) for now.
import { useState } from 'react';
import { RotateCw } from 'lucide-react';
import { PageCard } from '../../layouts/PageCard.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { EmptyState } from '../../components/EmptyState.js';
import { SecretRevealDialog } from '../../components/SecretRevealDialog.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { CreateOperatorDialog } from '../operators/CreateOperatorDialog.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { auditKeys, operatorKeys } from '../../queryKeys.js';
import { formatDate, formatRelative } from '../../lib/format.js';

interface Me {
  authenticated: boolean;
  subject?: string;
  email?: string;
  admin?: boolean;
}

interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  target: string;
  at: number;
}

interface OperatorRow {
  id: string;
  name: string;
  email: string;
  ssh_pubkey: string;
  ssh_pubkey_fp_sha256: string;
  api_key_id: string;
  role: 'admin' | 'operator' | 'readonly';
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
}

function roleVariant(role: OperatorRow['role']) {
  switch (role) {
    case 'admin':
      return 'success';
    case 'operator':
      return 'secondary';
    case 'readonly':
      return 'outline';
  }
}

export function Me() {
  const me = useAdminQuery<Me>(['me'] as const, '/api/me');
  // Operators list is small — fetching the whole thing + matching client-side
  // is cheaper than adding a `/operators/me` endpoint just for this page.
  // staleTime is 5min: the list rarely changes.
  const operators = useAdminQuery<{ data: OperatorRow[] }>(
    ['operators', 'all'] as const,
    '/api/admin/operators',
    { staleTime: 5 * 60_000 },
  );
  const audit = useAdminQuery<{ data: AuditEntry[] }>(
    auditKeys.chain(),
    '/api/admin/audit/chain?limit=200',
  );

  const myOperator =
    me.data?.email && operators.data
      ? operators.data.data.find((o) => o.email.toLowerCase() === me.data!.email!.toLowerCase())
      : undefined;

  const myEntries = (audit.data?.data ?? []).filter((e) =>
    me.data?.email ? e.actor.includes(me.data.email) : false,
  );

  const [rotatedToken, setRotatedToken] = useState<string | null>(null);
  // rotate-key reuses the operator's existing scopes, so self-service rotation
  // is no privilege change — just a fresh secret. The id is only read when the
  // button renders (operator present), never when undefined.
  const rotateKey = useAdminMutation<{ login_token: string }, undefined>(
    () => ({ path: `/api/admin/operators/${myOperator?.id}/rotate-key`, method: 'POST' }),
    {
      invalidateKeys: [operatorKeys.all],
      successMessage: 'Operator key rotated. Copy the new login token now.',
    },
  );

  async function handleRotate(): Promise<void> {
    const r = await rotateKey.mutateAsync(undefined);
    setRotatedToken(r.login_token);
  }

  return (
    <PageCard title="You" description="Identity, operator key, recent activity." decorative>
      <div className="space-y-6">
        <section>
          <h2 className="mb-2 text-xl font-medium">Identity</h2>
          {me.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : !me.data?.authenticated ? (
            <p className="text-sm text-[var(--color-destructive)]">Not signed in.</p>
          ) : (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-[var(--color-muted-foreground)]">Subject</dt>
              <dd className="font-mono">{me.data.subject}</dd>
              <dt className="text-[var(--color-muted-foreground)]">Email</dt>
              <dd>{me.data.email}</dd>
              <dt className="text-[var(--color-muted-foreground)]">Admin (OIDC)</dt>
              <dd>
                {me.data.admin ? (
                  <Badge variant="success">yes</Badge>
                ) : (
                  <Badge variant="outline">no</Badge>
                )}
              </dd>
            </dl>
          )}
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xl font-medium">Operator key</h2>
            {myOperator && !myOperator.disabled_at ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void handleRotate();
                }}
                disabled={rotateKey.isPending}
              >
                <RotateCw className="h-4 w-4" /> Rotate key
              </Button>
            ) : !operators.isLoading && !me.isLoading && !myOperator && me.data?.admin ? (
              <CreateOperatorDialog
                defaultName={me.data?.email ?? ''}
                defaultEmail={me.data?.email ?? ''}
                triggerLabel="Create my operator key"
              />
            ) : null}
          </div>
          {operators.isLoading || me.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : !myOperator ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              No operator row matches your email.{' '}
              {me.data?.admin ? (
                <>
                  Use <span className="font-medium">Create my operator key</span> above (you&apos;ll
                  paste an SSH public key), or run{' '}
                  <span className="font-mono">polaris-mail operator add</span>.
                </>
              ) : (
                <>
                  Operator keys are minted by{' '}
                  <span className="font-mono">polaris-mail operator add</span>; ask an admin to
                  onboard you if you need CLI/SSH access.
                </>
              )}
            </p>
          ) : (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-[var(--color-muted-foreground)]">Display name</dt>
              <dd>{myOperator.name}</dd>
              <dt className="text-[var(--color-muted-foreground)]">Role</dt>
              <dd>
                <Badge variant={roleVariant(myOperator.role)}>{myOperator.role}</Badge>
              </dd>
              <dt className="text-[var(--color-muted-foreground)]">API key id</dt>
              <dd className="font-mono text-xs">{myOperator.api_key_id}</dd>
              <dt className="text-[var(--color-muted-foreground)]">SSH fingerprint</dt>
              <dd className="font-mono text-xs">{myOperator.ssh_pubkey_fp_sha256}</dd>
              <dt className="text-[var(--color-muted-foreground)]">Last seen</dt>
              <dd className="text-xs" title={myOperator.last_seen_at ?? undefined}>
                {myOperator.last_seen_at ? formatRelative(myOperator.last_seen_at) : 'never'}
              </dd>
              <dt className="text-[var(--color-muted-foreground)]">Status</dt>
              <dd>
                {myOperator.disabled_at ? (
                  <Badge variant="destructive">disabled</Badge>
                ) : (
                  <Badge variant="success">active</Badge>
                )}
              </dd>
            </dl>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-xl font-medium">Recent activity</h2>
          {audit.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : myEntries.length === 0 ? (
            <EmptyState
              title="No audit entries"
              description="The chained audit log records nothing under your email yet."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {myEntries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-xs" title={formatDate(e.at)}>
                      {formatRelative(e.at)}
                    </TableCell>
                    <TableCell>{e.action}</TableCell>
                    <TableCell className="font-mono text-xs">{e.target}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      </div>

      <SecretRevealDialog
        open={rotatedToken !== null}
        onOpenChange={(o) => !o && setRotatedToken(null)}
        title="Operator key rotated"
        secretLabel="Login token"
        secret={rotatedToken}
        note="Paste this into `polaris-mail login`. Polaris stores only its hash — there is no way to retrieve this value again."
      />
    </PageCard>
  );
}
