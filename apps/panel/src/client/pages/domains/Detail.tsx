// Domain detail — DNS checklist via POST /v1/admin/domains/:id/verify plus
// inbound toggle and DKIM rotate. Panel never writes DNS records.
//
// "Disable inbound" and "Rotate DKIM" are destructive enough to confirm:
// disabling inbound blackholes mail to every receiver on the domain until
// re-enabled; rotating DKIM invalidates the previous selector and requires a
// DNS update before mail flow resumes.
import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { PageCard } from '../../layouts/PageCard.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { DestructiveActionDialog } from '../../components/DestructiveActionDialog.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { domainKeys } from '../../queryKeys.js';

interface DomainPayload {
  id: string;
  name: string;
  status: string;
  dkim_selector: string | null;
  inbound_enabled?: number;
  outbound_enabled?: number;
}

interface VerifyCheck {
  name: string;
  ok: boolean;
  expected: string;
  actual: string;
}

interface VerifyResponse {
  id: string;
  status: string;
  checks: VerifyCheck[];
  message?: string;
}

export function DomainDetail() {
  const { id } = useParams({ from: '/domains/$id' });
  const q = useAdminQuery<DomainPayload>(domainKeys.detail(id), `/api/admin/domains/${id}`);
  const [lastVerify, setLastVerify] = useState<VerifyResponse | null>(null);
  const [confirmRotateDkim, setConfirmRotateDkim] = useState(false);
  const [confirmDisableInbound, setConfirmDisableInbound] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const verify = useAdminMutation<VerifyResponse, undefined>(
    () => ({ path: `/api/admin/domains/${id}/verify`, method: 'POST' }),
    { invalidateKeys: [domainKeys.detail(id)], silent: true },
  );
  const rotate = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/domains/${id}/rotate-dkim`, method: 'POST' }),
    { invalidateKeys: [domainKeys.detail(id)], successMessage: 'DKIM rotated.' },
  );
  const enableInbound = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/domains/${id}/inbound/enable`, method: 'POST' }),
    { invalidateKeys: [domainKeys.detail(id)], successMessage: 'Inbound enabled.' },
  );
  const disableInbound = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/domains/${id}/inbound/disable`, method: 'POST' }),
    { invalidateKeys: [domainKeys.detail(id)], successMessage: 'Inbound disabled.' },
  );
  const remove = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/domains/${id}`, method: 'DELETE' }),
    { invalidateKeys: [domainKeys.all], successMessage: 'Domain deleted.' },
  );

  const breadcrumbs = [{ label: 'Domains', to: '/domains' }, { label: q.data?.name ?? id }];
  if (q.isLoading) {
    return (
      <PageCard title="Domain" breadcrumbs={breadcrumbs}>
        <Skeleton className="h-32 w-full" />
      </PageCard>
    );
  }
  if (q.error || !q.data) {
    return (
      <PageCard title="Domain" breadcrumbs={breadcrumbs}>
        <p className="text-sm text-[var(--color-destructive)]">
          {q.error?.message ?? 'Not found.'}
        </p>
      </PageCard>
    );
  }
  const d = q.data;

  return (
    <PageCard
      title={d.name}
      breadcrumbs={breadcrumbs}
      description={`DKIM selector: ${d.dkim_selector ?? 'cf'}`}
      decorative
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={d.status === 'verified' ? 'success' : 'secondary'}>{d.status}</Badge>
          <Button
            size="sm"
            onClick={async () => {
              const r = await verify.mutateAsync(undefined);
              setLastVerify(r);
            }}
            disabled={verify.isPending}
          >
            {verify.isPending ? 'Verifying…' : 'Verify DNS'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => enableInbound.mutate(undefined)}
            disabled={enableInbound.isPending}
          >
            Enable inbound
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmDisableInbound(true)}
            disabled={disableInbound.isPending}
          >
            Disable inbound
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmRotateDkim(true)}
            disabled={rotate.isPending}
          >
            Rotate DKIM
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setConfirmDelete(true)}
            disabled={remove.isPending}
          >
            Delete domain
          </Button>
        </div>

        <section>
          <h2 className="mb-2 text-xl font-medium">DNS checklist</h2>
          {lastVerify ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Check</TableHead>
                  <TableHead>OK</TableHead>
                  <TableHead>Expected</TableHead>
                  <TableHead>Actual</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lastVerify.checks.map((ch) => (
                  <TableRow key={ch.name}>
                    <TableCell className="font-mono text-xs">{ch.name}</TableCell>
                    <TableCell>
                      {ch.ok ? (
                        <Badge variant="success">ok</Badge>
                      ) : (
                        <Badge variant="destructive">fail</Badge>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{ch.expected}</TableCell>
                    <TableCell className="font-mono text-xs">{ch.actual}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Run Verify DNS to surface MX / SPF / DKIM / DMARC expectations.
            </p>
          )}
        </section>
      </div>

      <DestructiveActionDialog
        open={confirmRotateDkim}
        onOpenChange={setConfirmRotateDkim}
        action="Rotate DKIM"
        name={d.name}
        blastRadius={[
          'A new DKIM selector is generated; the previous selector stops signing',
          'Outbound mail will fail DKIM until the new selector is published in DNS',
          'You must update DNS with the new selector before mail flow resumes',
        ]}
        reversible={false}
        onConfirm={async () => {
          await rotate.mutateAsync(undefined);
          setConfirmRotateDkim(false);
        }}
        isPending={rotate.isPending}
      />

      <DestructiveActionDialog
        open={confirmDisableInbound}
        onOpenChange={setConfirmDisableInbound}
        action="Disable inbound"
        name={d.name}
        blastRadius={[
          'All receivers on this domain stop accepting mail',
          'Senders will see deferral or rejection at the MX level',
          'You can re-enable inbound at any time',
        ]}
        reversible
        confirmLabel="Disable inbound"
        onConfirm={async () => {
          await disableInbound.mutateAsync(undefined);
          setConfirmDisableInbound(false);
        }}
        isPending={disableInbound.isPending}
      />

      <DestructiveActionDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        action="Delete domain"
        name={d.name}
        blastRadius={[
          'All senders bound to this domain are revoked',
          'All receivers on this domain stop accepting mail',
          'DKIM selectors and DNS expectations are removed',
          'Existing message rows are retained for audit',
        ]}
        reversible={false}
        typedConfirmation={d.name}
        confirmLabel="Delete domain"
        onConfirm={async () => {
          await remove.mutateAsync(undefined);
          setConfirmDelete(false);
        }}
        isPending={remove.isPending}
      />
    </PageCard>
  );
}
