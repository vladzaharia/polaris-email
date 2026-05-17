// Cloudflare zones — discover-and-configure list view.
//
// Renders every zone in the operator's CF account with six per-zone status
// badges (Routing / DNS Locked / Sender / Catch-all / Rules / D1) plus a
// roll-up "overall" pill. The Configure column links to the per-zone detail
// page. Server-side caches the listing for 60s; the manual Refresh button
// passes `?refresh=1` to bypass.
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, Info, RefreshCw, X, AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorText } from '../../components/ErrorText.js';
import { PaginatedTable } from '../../components/PaginatedTable.js';
import { PageCard } from '../../layouts/PageCard.js';
import { useAdminQuery } from '../../hooks/useAdminApi.js';
import { apiFetch, ApiError } from '../../lib/api.js';
import { formatDate } from '../../lib/format.js';
import { cfZoneKeys } from '../../queryKeys.js';
import type { CfZoneListResponse, ZoneDomainStatus, ZoneOverall } from './types.js';

// Single-source truth for the six column-level checks. Each entry maps a
// `ZoneDomainStatus` row → tri-state ('ok' | 'warn' | 'bad') + an explanatory
// title for hover tooltip semantics.
type Check = 'ok' | 'warn' | 'bad';

interface CheckSpec {
  label: string;
  check: (z: ZoneDomainStatus) => { state: Check; title: string };
}

const CHECKS: CheckSpec[] = [
  {
    label: 'Routing',
    check: (z) => ({
      state: z.routing_enabled ? (z.routing_status_ok ? 'ok' : 'warn') : 'bad',
      title: `Email Routing ${z.routing_enabled ? 'enabled' : 'disabled'} (CF status: ${z.routing_status})`,
    }),
  },
  {
    label: 'DNS Locked',
    check: (z) => ({
      state: z.dns_records_locked ? (z.dns_record_errors.length === 0 ? 'ok' : 'warn') : 'bad',
      title: z.dns_records_locked
        ? z.dns_record_errors.length === 0
          ? 'CF owns MX/SPF; no errors reported.'
          : `CF owns MX/SPF; ${z.dns_record_errors.length} error(s) reported.`
        : 'DNS records not locked by Cloudflare.',
    }),
  },
  {
    label: 'Sender',
    check: (z) => ({
      state: z.sender_onboarded ? 'ok' : 'bad',
      title: z.sender_onboarded
        ? 'Sender domain onboarded.'
        : `Sender not onboarded${z.sender_missing_records.length ? `; missing: ${z.sender_missing_records.join(', ')}` : ''}.`,
    }),
  },
  {
    label: 'Catch-all',
    check: (z) => ({
      state: z.catch_all_correct ? 'ok' : 'bad',
      title: z.catch_all_target
        ? `Catch-all → ${z.catch_all_target}`
        : 'No catch-all rule configured.',
    }),
  },
  {
    label: 'Rules',
    check: (z) => ({
      state: z.has_conflicting_rules ? 'warn' : 'ok',
      title: z.has_conflicting_rules
        ? `${z.named_rules.filter((r) => !r.routes_to_polaris).length} named rule(s) route mail away from polaris-email-in.`
        : `${z.named_rules.length} named rule(s); none conflict.`,
    }),
  },
  {
    label: 'D1',
    check: (z) => ({
      state: z.d1_mail_domain_exists ? 'ok' : 'bad',
      title: z.d1_mail_domain_exists
        ? 'mail_domains row present.'
        : 'No mail_domains row for this zone.',
    }),
  },
];

function CheckBadge({ state, title }: { state: Check; title: string }) {
  const variant: 'success' | 'warning' | 'destructive' =
    state === 'ok' ? 'success' : state === 'warn' ? 'warning' : 'destructive';
  const Icon = state === 'ok' ? Check : state === 'warn' ? AlertTriangle : X;
  return (
    <Badge variant={variant} title={title} aria-label={title}>
      <Icon className="h-3 w-3" aria-hidden />
    </Badge>
  );
}

function OverallPill({ value }: { value: ZoneOverall }) {
  switch (value) {
    case 'ok':
      return (
        <Badge variant="success">
          <Check className="h-3 w-3" aria-hidden />
          <span>Configured</span>
        </Badge>
      );
    case 'partial':
      return (
        <Badge variant="warning">
          <AlertTriangle className="h-3 w-3" aria-hidden />
          <span>Partial</span>
        </Badge>
      );
    case 'unconfigured':
      return (
        <Badge variant="secondary">
          <Info className="h-3 w-3" aria-hidden />
          <span>Unconfigured</span>
        </Badge>
      );
    case 'error':
      return (
        <Badge variant="destructive">
          <X className="h-3 w-3" aria-hidden />
          <span>Error</span>
        </Badge>
      );
  }
}

export function CfZonesList() {
  const qc = useQueryClient();
  const q = useAdminQuery<CfZoneListResponse>(cfZoneKeys.list(), '/api/admin/cf-zones');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<ApiError | Error | null>(null);

  async function refresh() {
    setRefreshError(null);
    setRefreshing(true);
    try {
      const r = await apiFetch<CfZoneListResponse>('/api/admin/cf-zones?refresh=1');
      qc.setQueryData(cfZoneKeys.list(), r.body);
    } catch (e) {
      setRefreshError(e as Error);
    } finally {
      setRefreshing(false);
    }
  }

  const rows = q.data?.data ?? [];
  const fetchedAt = q.data?.fetched_at ?? null;
  const cached = q.data?.cached ?? false;

  return (
    <PageCard
      title="CF Zones"
      description="Cloudflare-account zones with discover-and-configure status. Click Configure to inspect a single zone or apply remediations."
      decorative
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--color-muted-foreground)]">
        <div>
          {fetchedAt ? (
            <>
              Last refreshed at <span className="font-mono">{formatDate(fetchedAt)}</span>
              {cached ? ' (cached)' : ''}
            </>
          ) : (
            'Loading…'
          )}
        </div>
        <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={refreshing}>
          <RefreshCw className={'mr-1 h-3 w-3' + (refreshing ? ' animate-spin' : '')} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <ErrorText error={refreshError ?? q.error} />

      {!q.isLoading && rows.length === 0 && !q.error ? (
        <EmptyState
          title="No CF zones found"
          description="No zones were returned by the Cloudflare account scoped by CF_API_TOKEN. Verify the token has Zone:Read on the account."
        />
      ) : (
        <PaginatedTable<ZoneDomainStatus>
          caption="Cloudflare zones with per-zone discover-and-configure status."
          loading={q.isLoading}
          rows={rows}
          empty="No CF zones."
          rowKey={(z) => z.zone.id}
          columns={[
            {
              key: 'zone',
              header: 'Zone',
              cell: (z) => (
                <Link
                  to="/cf-zones/$name"
                  params={{ name: z.zone.name }}
                  className="font-mono text-sm underline"
                >
                  {z.zone.name}
                </Link>
              ),
            },
            ...CHECKS.map((c) => ({
              key: c.label,
              header: c.label,
              cell: (z: ZoneDomainStatus) => {
                const r = c.check(z);
                return <CheckBadge state={r.state} title={r.title} />;
              },
            })),
            {
              key: 'overall',
              header: 'Overall',
              cell: (z) => <OverallPill value={z.overall} />,
            },
            {
              key: 'action',
              header: '',
              cell: (z) => (
                <Link to="/cf-zones/$name" params={{ name: z.zone.name }}>
                  <Button size="sm" variant="outline">
                    Configure
                  </Button>
                </Link>
              ),
            },
          ]}
        />
      )}
    </PageCard>
  );
}
