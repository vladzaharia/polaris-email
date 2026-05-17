// CF zone detail — six-section breakdown of one zone's discover-and-configure
// state. Refresh button hits the always-fresh single-zone endpoint; Configure
// button opens the dry-run/apply modal.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { AlertTriangle, Check, RefreshCw, X } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { ErrorText } from '../../components/ErrorText.js';
import { PageCard } from '../../layouts/PageCard.js';
import { useAdminQuery } from '../../hooks/useAdminApi.js';
import { apiFetch, ApiError } from '../../lib/api.js';
import { cfZoneKeys } from '../../queryKeys.js';
import { ConfigureModal } from './ConfigureModal.js';
import type { CfZoneDetailResponse, ZoneDomainStatus, ZoneOverall } from './types.js';

function OverallPill({ value }: { value: ZoneOverall }) {
  const map: Record<
    ZoneOverall,
    { variant: 'success' | 'warning' | 'secondary' | 'destructive'; label: string }
  > = {
    ok: { variant: 'success', label: 'Configured' },
    partial: { variant: 'warning', label: 'Partial' },
    unconfigured: { variant: 'secondary', label: 'Unconfigured' },
    error: { variant: 'destructive', label: 'Error' },
  };
  const spec = map[value];
  return <Badge variant={spec.variant}>{spec.label}</Badge>;
}

function StateRow({ label, ok, detail }: { label: string; ok: boolean; detail?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] py-2 last:border-0">
      <div className="text-sm font-medium">{label}</div>
      <div className="flex items-center gap-2 text-right text-xs">
        <Badge variant={ok ? 'success' : 'destructive'}>
          {ok ? <Check className="h-3 w-3" aria-hidden /> : <X className="h-3 w-3" aria-hidden />}
          <span>{ok ? 'ok' : 'no'}</span>
        </Badge>
        {detail ? <div className="text-[var(--color-muted-foreground)]">{detail}</div> : null}
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-[var(--color-border)] p-4">
      <header className="mb-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {description ? (
          <p className="text-xs text-[var(--color-muted-foreground)]">{description}</p>
        ) : null}
      </header>
      <div>{children}</div>
    </section>
  );
}

export function CfZoneDetail() {
  const { name } = useParams({ from: '/cf-zones/$name' });
  const qc = useQueryClient();
  const q = useAdminQuery<CfZoneDetailResponse>(
    cfZoneKeys.detail(name),
    `/api/admin/cf-zones/${encodeURIComponent(name)}`,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<ApiError | Error | null>(null);
  const [configureOpen, setConfigureOpen] = useState(false);

  async function refresh() {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const r = await apiFetch<CfZoneDetailResponse>(
        `/api/admin/cf-zones/${encodeURIComponent(name)}`,
      );
      qc.setQueryData(cfZoneKeys.detail(name), r.body);
      // Invalidate the list so a return-trip surfaces the new state too.
      void qc.invalidateQueries({ queryKey: cfZoneKeys.list() });
    } catch (e) {
      setRefreshError(e as Error);
    } finally {
      setRefreshing(false);
    }
  }

  const breadcrumbs = [{ label: 'CF Zones', to: '/cf-zones' }, { label: name }];

  if (q.isLoading) {
    return (
      <PageCard title={name} breadcrumbs={breadcrumbs}>
        <Skeleton className="h-48 w-full" />
      </PageCard>
    );
  }
  if (q.error || !q.data) {
    return (
      <PageCard title={name} breadcrumbs={breadcrumbs}>
        <ErrorText error={q.error ?? 'Not found.'} />
      </PageCard>
    );
  }

  const z: ZoneDomainStatus = q.data.data;
  const conflictRules = z.named_rules.filter((r) => !r.routes_to_polaris);

  return (
    <PageCard
      title={name}
      breadcrumbs={breadcrumbs}
      description={`CF zone ${z.zone.id} — ${z.zone.status}`}
      decorative
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <OverallPill value={z.overall} />
            {z.error ? (
              <span className="text-xs text-[var(--color-destructive)]">{z.error}</span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              <RefreshCw
                className={'mr-1 h-3 w-3' + (refreshing ? ' animate-spin' : '')}
                aria-hidden
              />
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
        </div>

        <ErrorText error={refreshError} />

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Section
            title="Routing"
            description="Cloudflare Email Routing must be enabled and reporting `ready`."
          >
            <StateRow
              label="Email Routing enabled"
              ok={z.routing_enabled}
              detail={<span className="font-mono">status: {z.routing_status}</span>}
            />
            <StateRow label="Routing status OK" ok={z.routing_status_ok} />
          </Section>

          <Section
            title="DNS Records"
            description="CF should own the MX/SPF records for this zone (locked)."
          >
            <StateRow label="DNS records locked" ok={z.dns_records_locked} />
            {z.dns_record_errors.length > 0 ? (
              <div className="mt-2 rounded bg-[var(--color-destructive)]/10 p-2 text-xs">
                <p className="font-semibold text-[var(--color-destructive)]">DNS errors</p>
                <ul className="mt-1 list-inside list-disc">
                  {z.dns_record_errors.map((err) => (
                    <li key={err}>{err}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Section>

          <Section
            title="Sender Onboarding"
            description="DKIM/MAIL-FROM records published via the Email Service auto-publish API."
          >
            <StateRow label="Sender onboarded" ok={z.sender_onboarded} />
            {z.sender_missing_records.length > 0 ? (
              <div className="mt-2 rounded bg-[var(--color-warning)]/10 p-2 text-xs">
                <p className="font-semibold">Missing records</p>
                <ul className="mt-1 list-inside list-disc">
                  {z.sender_missing_records.map((r) => (
                    <li key={r} className="font-mono">
                      {r}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Section>

          <Section
            title="Catch-all rule"
            description="Catch-all should route to the inbound Worker (polaris-email-in)."
          >
            <StateRow
              label="Catch-all routes to polaris"
              ok={z.catch_all_correct}
              detail={
                z.catch_all_target ? (
                  <span className="font-mono">→ {z.catch_all_target}</span>
                ) : (
                  <span>none</span>
                )
              }
            />
          </Section>

          <Section
            title="Named rules"
            description="Operator-defined named-address rules. Polaris only flags conflicts."
          >
            <div className="mb-2 flex items-center gap-2 text-xs">
              <Badge variant={conflictRules.length === 0 ? 'success' : 'warning'}>
                {conflictRules.length === 0 ? (
                  <Check className="h-3 w-3" aria-hidden />
                ) : (
                  <AlertTriangle className="h-3 w-3" aria-hidden />
                )}
                <span>
                  {conflictRules.length === 0
                    ? `${z.named_rules.length} rule(s); no conflicts`
                    : `${conflictRules.length} conflict(s)`}
                </span>
              </Badge>
            </div>
            {z.named_rules.length === 0 ? (
              <p className="text-xs text-[var(--color-muted-foreground)]">No named rules.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Pattern</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Target</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {z.named_rules.map((r) => (
                    <TableRow key={r.name}>
                      <TableCell className="font-mono text-xs">
                        {r.name}
                        {!r.enabled ? (
                          <Badge variant="secondary" className="ml-2">
                            disabled
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {r.address_pattern ?? '—'}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{r.action_type ?? '—'}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {r.action_target ?? '—'}
                        {!r.routes_to_polaris ? (
                          <Badge
                            variant="warning"
                            className="ml-2"
                            title="Routes mail away from polaris-email-in."
                          >
                            <AlertTriangle className="h-3 w-3" aria-hidden />
                            <span>conflict</span>
                          </Badge>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>

          <Section
            title="D1 mail_domains row"
            description="Polaris-side `mail_domains` row that mailbox/sender objects FK to."
          >
            <StateRow label="mail_domains row exists" ok={z.d1_mail_domain_exists} />
          </Section>
        </div>

        {z.overall !== 'ok' ? (
          <div className="flex justify-end">
            <Button onClick={() => setConfigureOpen(true)}>Configure</Button>
          </div>
        ) : null}
      </div>

      <ConfigureModal
        zoneName={name}
        open={configureOpen}
        onOpenChange={setConfigureOpen}
        onApplied={() => void refresh()}
      />
    </PageCard>
  );
}
