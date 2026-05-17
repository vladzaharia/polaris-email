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
import { formatRelative } from '../../lib/format.js';
import { dmarcKeys, domainKeys, tlsRptKeys } from '../../queryKeys.js';

// W6 — DMARC alignment subsection. Embedded in the Inbound TLS hardening
// section as a sibling block; pulls the 7/14/30-day alignment rollup.
interface DmarcSummaryPayload {
  domain: string;
  today: string;
  last_7d: {
    reports: number;
    total: number;
    dmarc_pass_pct: number;
    dkim_pass_pct: number;
    spf_pass_pct: number;
    last_seen_at: string | null;
  };
  last_14d: {
    reports: number;
    total: number;
    dmarc_pass_pct: number;
    dkim_pass_pct: number;
    spf_pass_pct: number;
    last_seen_at: string | null;
  };
  last_30d: {
    reports: number;
    total: number;
    dmarc_pass_pct: number;
    dkim_pass_pct: number;
    spf_pass_pct: number;
    last_seen_at: string | null;
  };
}

function DmarcAlignmentSummary({ domainName }: { domainName: string }) {
  const q = useAdminQuery<DmarcSummaryPayload>(
    dmarcKeys.summary(domainName),
    `/api/admin/dmarc-reports/summary?domain=${encodeURIComponent(domainName)}`,
  );
  if (q.isLoading || q.error || !q.data) return null;
  const d = q.data;
  const noData = d.last_30d.reports === 0;
  return (
    <div className="mt-6 rounded-md border border-[var(--color-border)] p-4">
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-muted-foreground)]">
        DMARC alignment
      </h3>
      {noData ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">
          No DMARC aggregate reports yet. Ensure the domain's `_dmarc` record's `rua=` field
          includes <code>mailto:dmarc-rua@plrs.im</code>.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4">
          <span className="font-medium">7d DMARC pass</span>
          <span>
            <Badge
              variant={
                d.last_7d.dmarc_pass_pct >= 99
                  ? 'success'
                  : d.last_7d.dmarc_pass_pct >= 90
                    ? 'secondary'
                    : 'destructive'
              }
            >
              {d.last_7d.dmarc_pass_pct}%
            </Badge>
          </span>
          <span className="font-medium">7d DKIM pass</span>
          <span>{d.last_7d.dkim_pass_pct}%</span>
          <span className="font-medium">7d SPF pass</span>
          <span>{d.last_7d.spf_pass_pct}%</span>
          <span className="font-medium">7d volume</span>
          <span>{d.last_7d.total.toLocaleString()}</span>
          <span className="font-medium">30d DMARC pass</span>
          <span>{d.last_30d.dmarc_pass_pct}%</span>
          <span className="font-medium">30d volume</span>
          <span>{d.last_30d.total.toLocaleString()}</span>
          <span className="font-medium">Last report</span>
          <span className="md:col-span-3" title={d.last_30d.last_seen_at ?? ''}>
            {d.last_30d.last_seen_at ? formatRelative(d.last_30d.last_seen_at) : '—'}
          </span>
        </div>
      )}
    </div>
  );
}

// W5 — TLS report summary subsection embedded in the Inbound TLS hardening
// section. Pulls the W5 admin summary endpoint and renders the 7/30-day
// success/failure totals + top failure-reason breakdown for this domain.
interface TlsReportSummaryPayload {
  domain: string;
  last_7d: { reports: number; success: number; failure: number; latest_at: string | null };
  last_30d: { reports: number; success: number; failure: number; latest_at: string | null };
  top_failures_7d: Array<{ result_type: string; failed: number }>;
}

function TlsReportSummary({ domainName }: { domainName: string }) {
  const q = useAdminQuery<TlsReportSummaryPayload>(
    tlsRptKeys.summary(domainName),
    `/api/admin/tls-rpt-reports/summary?domain=${encodeURIComponent(domainName)}`,
  );
  if (q.isLoading) return null; // section is non-critical; skip skeleton flicker
  if (q.error || !q.data) return null; // empty / no reports yet — silent
  const d = q.data;
  const noData = d.last_30d.reports === 0;
  return (
    <div className="mt-6 rounded-md border border-[var(--color-border)] p-4">
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-muted-foreground)]">
        TLS report summary
      </h3>
      {noData ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">
          No TLS-RPT reports received yet for this domain.{' '}
          {d.last_7d.latest_at
            ? null
            : 'Once senders start delivering reports they will appear here.'}
        </p>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4">
            <span className="font-medium">7d reports</span>
            <span>{d.last_7d.reports}</span>
            <span className="font-medium">30d reports</span>
            <span>{d.last_30d.reports}</span>
            <span className="font-medium">7d success</span>
            <span>{d.last_7d.success.toLocaleString()}</span>
            <span className="font-medium">7d failures</span>
            <span>
              {d.last_7d.failure > 0 ? (
                <Badge variant="destructive">{d.last_7d.failure.toLocaleString()}</Badge>
              ) : (
                d.last_7d.failure.toLocaleString()
              )}
            </span>
            <span className="font-medium">Last report</span>
            <span className="md:col-span-3" title={d.last_30d.latest_at ?? ''}>
              {d.last_30d.latest_at ? formatRelative(d.last_30d.latest_at) : '—'}
            </span>
          </div>
          {d.top_failures_7d.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Failure type (7d)</TableHead>
                  <TableHead>Failed sessions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.top_failures_7d.map((f) => (
                  <TableRow key={f.result_type}>
                    <TableCell className="font-mono text-xs">{f.result_type}</TableCell>
                    <TableCell>{f.failed.toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </div>
  );
}

interface DomainPayload {
  id: string;
  name: string;
  status: string;
  dkim_selector: string | null;
  inbound_enabled?: number;
  outbound_enabled?: number;
  // MTA-STS + TLS-RPT
  mta_sts_mode?: 'none' | 'testing' | 'enforce';
  mta_sts_policy_id?: string | null;
  mta_sts_max_age?: number;
  mta_sts_verified_at?: string | null;
  tlsrpt_enabled?: number;
  tlsrpt_rua?: string | null;
  tlsrpt_verified_at?: string | null;
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
  const [confirmPromoteMtaSts, setConfirmPromoteMtaSts] = useState(false);
  const [confirmDisableMtaSts, setConfirmDisableMtaSts] = useState(false);
  const [confirmDisableTlsRpt, setConfirmDisableTlsRpt] = useState(false);
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
  const enableMtaSts = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/domains/${id}/mta-sts/enable`, method: 'POST' }),
    { invalidateKeys: [domainKeys.detail(id)], successMessage: 'MTA-STS enabled (testing mode).' },
  );
  const promoteMtaSts = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/domains/${id}/mta-sts/promote`, method: 'POST' }),
    { invalidateKeys: [domainKeys.detail(id)], successMessage: 'MTA-STS promoted to enforce.' },
  );
  const disableMtaSts = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/domains/${id}/mta-sts/disable`, method: 'POST' }),
    { invalidateKeys: [domainKeys.detail(id)], successMessage: 'MTA-STS disabled.' },
  );
  const enableTlsRpt = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/domains/${id}/tls-rpt/enable`, method: 'POST' }),
    { invalidateKeys: [domainKeys.detail(id)], successMessage: 'TLS-RPT enabled.' },
  );
  const disableTlsRpt = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/domains/${id}/tls-rpt/disable`, method: 'POST' }),
    { invalidateKeys: [domainKeys.detail(id)], successMessage: 'TLS-RPT disabled.' },
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
                {lastVerify.checks.map((ch) => {
                  const isMtaStsAction = ch.name.startsWith('mta-sts:operator-action:');
                  const isTlsRptAction = ch.name.startsWith('tls-rpt:operator-action:');
                  const isOperatorAction = isMtaStsAction || isTlsRptAction;
                  const inlineFix = isMtaStsAction
                    ? {
                        label: 'Re-publish MTA-STS',
                        run: () => enableMtaSts.mutate(undefined),
                        pending: enableMtaSts.isPending,
                      }
                    : isTlsRptAction
                      ? {
                          label: 'Re-publish TLS-RPT',
                          run: () => enableTlsRpt.mutate(undefined),
                          pending: enableTlsRpt.isPending,
                        }
                      : null;
                  return (
                    <TableRow
                      key={ch.name}
                      className={
                        isOperatorAction ? 'bg-yellow-50 dark:bg-yellow-900/30' : undefined
                      }
                    >
                      <TableCell className="font-mono text-xs">{ch.name}</TableCell>
                      <TableCell>
                        {ch.ok ? (
                          <Badge variant="success">ok</Badge>
                        ) : (
                          <Badge variant="destructive">
                            {isOperatorAction ? 'action required' : 'fail'}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{ch.expected}</TableCell>
                      <TableCell className={isOperatorAction ? 'text-xs' : 'font-mono text-xs'}>
                        <div className="flex flex-col gap-2">
                          <span>{ch.actual}</span>
                          {inlineFix && (
                            <Button
                              size="sm"
                              onClick={async () => {
                                inlineFix.run();
                                // Re-verify after the action lands so the checklist refreshes.
                                const r = await verify.mutateAsync(undefined);
                                setLastVerify(r);
                              }}
                              disabled={inlineFix.pending}
                            >
                              {inlineFix.pending ? 'Working…' : inlineFix.label}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Run Verify DNS to surface MX / SPF / DKIM / DMARC expectations.
            </p>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-xl font-medium">Inbound TLS hardening</h2>
          <p className="mb-3 text-sm text-[var(--color-muted-foreground)]">
            MTA-STS (RFC 8461) and TLS-RPT (RFC 8460) records harden inbound TLS for this domain.
            Unlike DKIM/SPF/DMARC which Cloudflare auto-publishes, MTA-STS records require explicit
            operator action — use the buttons below to publish, promote, or remove them.
          </p>
          <div className="mb-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <span className="font-medium">MTA-STS mode</span>
            <span>
              <Badge
                variant={
                  d.mta_sts_mode === 'enforce'
                    ? 'success'
                    : d.mta_sts_mode === 'testing'
                      ? 'secondary'
                      : 'outline'
                }
              >
                {d.mta_sts_mode ?? 'none'}
              </Badge>
            </span>
            <span className="font-medium">Policy id</span>
            <span className="font-mono text-xs">{d.mta_sts_policy_id ?? '—'}</span>
            <span className="font-medium">Max age</span>
            <span>{d.mta_sts_max_age != null ? `${d.mta_sts_max_age}s` : '—'}</span>
            <span className="font-medium">MTA-STS verified</span>
            <span title={d.mta_sts_verified_at ?? undefined}>
              {d.mta_sts_verified_at ? formatRelative(d.mta_sts_verified_at) : 'never'}
            </span>
            <span className="font-medium">TLS-RPT enabled</span>
            <span>{d.tlsrpt_enabled === 1 ? 'yes' : 'no'}</span>
            <span className="font-medium">TLS-RPT rua</span>
            <span className="font-mono text-xs">{d.tlsrpt_rua ?? '—'}</span>
            <span className="font-medium">TLS-RPT verified</span>
            <span title={d.tlsrpt_verified_at ?? undefined}>
              {d.tlsrpt_verified_at ? formatRelative(d.tlsrpt_verified_at) : 'never'}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {(!d.mta_sts_mode || d.mta_sts_mode === 'none') && (
              <Button
                size="sm"
                onClick={() => enableMtaSts.mutate(undefined)}
                disabled={enableMtaSts.isPending}
              >
                Enable MTA-STS (testing)
              </Button>
            )}
            {d.mta_sts_mode === 'testing' && (
              <Button
                size="sm"
                onClick={() => enableMtaSts.mutate(undefined)}
                disabled={enableMtaSts.isPending}
              >
                Re-publish MTA-STS
              </Button>
            )}
            {d.mta_sts_mode === 'testing' && (
              <Button
                size="sm"
                onClick={() => setConfirmPromoteMtaSts(true)}
                disabled={promoteMtaSts.isPending}
              >
                Promote to enforce
              </Button>
            )}
            {d.mta_sts_mode === 'enforce' && (
              <Button
                size="sm"
                onClick={() => enableMtaSts.mutate(undefined)}
                disabled={enableMtaSts.isPending}
              >
                Re-publish MTA-STS
              </Button>
            )}
            {d.mta_sts_mode && d.mta_sts_mode !== 'none' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirmDisableMtaSts(true)}
                disabled={disableMtaSts.isPending}
              >
                Disable MTA-STS
              </Button>
            )}
            {d.tlsrpt_enabled !== 1 && (
              <Button
                size="sm"
                onClick={() => enableTlsRpt.mutate(undefined)}
                disabled={enableTlsRpt.isPending}
              >
                Enable TLS-RPT
              </Button>
            )}
            {d.tlsrpt_enabled === 1 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirmDisableTlsRpt(true)}
                disabled={disableTlsRpt.isPending}
              >
                Disable TLS-RPT
              </Button>
            )}
          </div>

          {/* W5 — TLS report summary subsection. Renders 7d/30d aggregates
              and the top failure types from inbound TLS-RPT reports. */}
          <TlsReportSummary domainName={d.name} />

          {/* W6 — DMARC alignment subsection. 7/14/30d pass-rate snapshot
              that the W8 promotion cron also reads to decide policy moves. */}
          <DmarcAlignmentSummary domainName={d.name} />
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

      <DestructiveActionDialog
        open={confirmPromoteMtaSts}
        onOpenChange={setConfirmPromoteMtaSts}
        action="Promote MTA-STS to enforce"
        name={d.name}
        blastRadius={[
          'Sending MTAs that fail TLS to *.mx.cloudflare.net will REJECT mail',
          'Previously cached `testing` policies will refresh on their next max_age expiry',
          'A new policy id is minted; senders re-fetch immediately',
        ]}
        reversible
        confirmLabel="Promote to enforce"
        onConfirm={async () => {
          await promoteMtaSts.mutateAsync(undefined);
          setConfirmPromoteMtaSts(false);
        }}
        isPending={promoteMtaSts.isPending}
      />

      <DestructiveActionDialog
        open={confirmDisableMtaSts}
        onOpenChange={setConfirmDisableMtaSts}
        action="Disable MTA-STS"
        name={d.name}
        blastRadius={[
          'DNS TXT _mta-sts.{name} is deleted',
          'Worker custom domain mta-sts.{name} is detached',
          'Senders with cached policies will follow them until max_age expires',
          'You can re-enable later via Enable MTA-STS',
        ]}
        reversible
        confirmLabel="Disable MTA-STS"
        onConfirm={async () => {
          await disableMtaSts.mutateAsync(undefined);
          setConfirmDisableMtaSts(false);
        }}
        isPending={disableMtaSts.isPending}
      />

      <DestructiveActionDialog
        open={confirmDisableTlsRpt}
        onOpenChange={setConfirmDisableTlsRpt}
        action="Disable TLS-RPT"
        name={d.name}
        blastRadius={[
          'DNS TXT _smtp._tls.{name} is deleted',
          'Senders stop sending TLS failure reports',
          'You can re-enable later via Enable TLS-RPT',
        ]}
        reversible
        confirmLabel="Disable TLS-RPT"
        onConfirm={async () => {
          await disableTlsRpt.mutateAsync(undefined);
          setConfirmDisableTlsRpt(false);
        }}
        isPending={disableTlsRpt.isPending}
      />
    </PageCard>
  );
}
