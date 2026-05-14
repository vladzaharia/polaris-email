// Domain detail — DNS checklist via POST /v1/admin/domains/:id/verify plus
// inbound/outbound toggles and DKIM rotate. Panel never writes DNS records.
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
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';

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
  const q = useAdminQuery<DomainPayload>(['domain', id], `/api/admin/domains/${id}`);
  const [lastVerify, setLastVerify] = useState<VerifyResponse | null>(null);
  const verify = useAdminMutation<VerifyResponse, undefined>(
    () => ({ path: `/api/admin/domains/${id}/verify`, method: 'POST' }),
    { invalidateKeys: [['domain', id]] },
  );
  const rotate = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/domains/${id}/rotate-dkim`, method: 'POST' }),
    { invalidateKeys: [['domain', id]] },
  );
  const enableInbound = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/domains/${id}/inbound/enable`, method: 'POST' }),
    { invalidateKeys: [['domain', id]] },
  );
  const disableInbound = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/domains/${id}/inbound/disable`, method: 'POST' }),
    { invalidateKeys: [['domain', id]] },
  );

  if (q.isLoading) {
    return (
      <PageCard title="Domain">
        <Skeleton className="h-32 w-full" />
      </PageCard>
    );
  }
  if (q.error || !q.data) {
    return (
      <PageCard title="Domain">
        <p className="text-sm text-[var(--color-destructive)]">
          {q.error?.message ?? 'Not found.'}
        </p>
      </PageCard>
    );
  }
  const d = q.data;

  return (
    <PageCard title={d.name} description={`DKIM selector: ${d.dkim_selector ?? 'cf'}`} decorative>
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
            onClick={() => disableInbound.mutate(undefined)}
            disabled={disableInbound.isPending}
          >
            Disable inbound
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => rotate.mutate(undefined)}
            disabled={rotate.isPending}
          >
            Rotate DKIM
          </Button>
        </div>

        <section>
          <h2 className="mb-2 text-sm font-semibold">DNS checklist</h2>
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
    </PageCard>
  );
}
