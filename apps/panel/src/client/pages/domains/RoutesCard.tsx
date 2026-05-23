// RoutesCard — unified inbound-route view for a domain.
//
// Combines two data sources into one table:
//   1. Polaris `mailbox_receivers` for this domain (the internal pattern →
//      mailbox bindings — webhook delivery, forwards, drops).
//   2. CF Email Routing named rules for the zone (the external operator-
//      defined rules forward/worker/drop).
//
// A CF rule whose action is `worker → polaris-mail-in` is operationally a
// Polaris entry point, not an external endpoint. We merge those into the
// matching Polaris receiver row (keyed on the lowercased canonical
// address) and surface a `via CF` indicator. If no Polaris receiver
// matches a polaris-routed CF rule, we still emit a polaris-source row so
// the operator sees the partial config rather than nothing.
import { Link } from '@tanstack/react-router';
import { ArrowRight, ExternalLink, Route } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { Badge } from '../../components/ui/badge.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorText } from '../../components/ErrorText.js';
import { useAdminQuery } from '../../hooks/useAdminApi.js';
import { cfZoneKeys, domainKeys } from '../../queryKeys.js';
import { ApiError } from '../../lib/api.js';

const INBOUND_WORKER_NAME = 'polaris-mail-in';

interface ReceiverRow {
  id: string;
  mailbox_id: string;
  domain_id: string;
  priority: number;
  address_pattern: string;
  action: 'webhook' | 'forward' | 'drop';
  webhook_sub_id: string | null;
  forward_to: string | null;
  enabled: number;
  created_at: string;
  disabled_at: string | null;
  mailbox_name: string;
}

interface NamedRouteRule {
  name: string;
  address_pattern: string | null;
  action_type: string | null;
  action_target: string | null;
  enabled: boolean;
  routes_to_polaris: boolean;
}

interface CfZoneStatusLite {
  zone: { id: string; name: string };
  named_rules: NamedRouteRule[];
}

interface UnifiedRoute {
  key: string;
  source: 'polaris' | 'cf';
  enabled: boolean;
  displayPattern: string;
  patternIsMissing: boolean;
  actionKind: 'webhook' | 'forward' | 'drop' | 'worker' | 'polaris-default' | 'unknown';
  actionTarget: string | null;
  actionHref: string | null;
  /** Worker name when the action ultimately delivers to a non-polaris CF Worker. */
  externalWorkerName: string | null;
  priority: number | null;
  frontedByCf: string | null;
}

function localPartToFullAddress(localPattern: string, domainName: string): string {
  return localPattern === '*' ? `*@${domainName}` : `${localPattern}@${domainName}`;
}

function toUnifiedRoutes(
  receivers: ReceiverRow[],
  rules: NamedRouteRule[],
  domainName: string,
): UnifiedRoute[] {
  // Index polaris-routed CF rules by lowercased canonical address so we
  // can mark matching Polaris receivers as "fronted by CF" and detect
  // orphan polaris-routed CF rules (no matching receiver).
  const polarisRoutedByAddr = new Map<string, NamedRouteRule>();
  for (const r of rules) {
    if (r.routes_to_polaris && r.address_pattern) {
      polarisRoutedByAddr.set(r.address_pattern.toLowerCase(), r);
    }
  }
  const consumedRuleNames = new Set<string>();

  const polarisRows: UnifiedRoute[] = receivers.map((rec) => {
    const fullAddr = localPartToFullAddress(rec.address_pattern, domainName).toLowerCase();
    const fronting = polarisRoutedByAddr.get(fullAddr);
    if (fronting) consumedRuleNames.add(fronting.name);
    let actionKind: UnifiedRoute['actionKind'];
    let actionTarget: string | null;
    let actionHref: string | null;
    if (rec.action === 'webhook') {
      actionKind = 'webhook';
      actionTarget = rec.mailbox_name;
      actionHref = `/mailboxes/${rec.mailbox_id}`;
    } else if (rec.action === 'forward') {
      actionKind = 'forward';
      actionTarget = rec.forward_to;
      actionHref = null;
    } else {
      actionKind = 'drop';
      actionTarget = null;
      actionHref = null;
    }
    return {
      key: `polaris:${rec.id}`,
      source: 'polaris',
      enabled: rec.enabled === 1 && rec.disabled_at === null,
      displayPattern: localPartToFullAddress(rec.address_pattern, domainName),
      patternIsMissing: false,
      actionKind,
      actionTarget,
      actionHref,
      externalWorkerName: null,
      priority: rec.priority,
      frontedByCf: fronting?.name ?? null,
    };
  });

  // Orphan polaris-routed CF rules: an operator pinned a specific address
  // to polaris-mail-in but didn't create a matching Polaris receiver.
  // Surface so the partial config is visible.
  const orphanPolarisRows: UnifiedRoute[] = [];
  for (const [addr, rule] of polarisRoutedByAddr) {
    if (consumedRuleNames.has(rule.name)) continue;
    orphanPolarisRows.push({
      key: `cf-polaris:${rule.name}`,
      source: 'polaris',
      enabled: rule.enabled,
      displayPattern: rule.address_pattern ?? addr,
      patternIsMissing: false,
      actionKind: 'polaris-default',
      actionTarget: null,
      actionHref: null,
      externalWorkerName: null,
      priority: null,
      frontedByCf: rule.name,
    });
  }

  // Truly external CF rules: action doesn't route to polaris-mail-in.
  const externalRows: UnifiedRoute[] = rules
    .filter((r) => !r.routes_to_polaris)
    .map((rule) => {
      let actionKind: UnifiedRoute['actionKind'];
      let externalWorkerName: string | null = null;
      const at = rule.action_type;
      if (at === 'forward') {
        actionKind = 'forward';
      } else if (at === 'drop') {
        actionKind = 'drop';
      } else if (at === 'worker') {
        actionKind = 'worker';
        externalWorkerName =
          rule.action_target && rule.action_target !== INBOUND_WORKER_NAME
            ? rule.action_target
            : null;
      } else {
        actionKind = 'unknown';
      }
      return {
        key: `cf:${rule.name}`,
        source: 'cf',
        enabled: rule.enabled,
        displayPattern: rule.address_pattern ?? '(no pattern)',
        patternIsMissing: rule.address_pattern === null,
        actionKind,
        actionTarget: rule.action_target,
        actionHref: null,
        externalWorkerName,
        priority: null,
        frontedByCf: null,
      };
    });

  // Polaris rows first (with their orphan polaris-routed CF rules
  // intermixed by priority — orphans have null priority so they sort
  // last within the polaris group), then external rows.
  const allPolaris = [...polarisRows, ...orphanPolarisRows].sort((a, b) => {
    const ap = a.priority ?? Number.POSITIVE_INFINITY;
    const bp = b.priority ?? Number.POSITIVE_INFINITY;
    return ap - bp;
  });
  return [...allPolaris, ...externalRows];
}

function ActionCell({ row }: { row: UnifiedRoute }) {
  if (row.actionKind === 'webhook' && row.actionHref) {
    return (
      <span className="inline-flex items-center gap-1">
        <ArrowRight className="h-3 w-3 text-[var(--color-muted-foreground)]" aria-hidden />
        <Link
          to="/mailboxes/$id"
          params={{ id: row.actionHref.replace('/mailboxes/', '') }}
          className="underline hover:text-[var(--color-foreground)]"
        >
          {row.actionTarget}
        </Link>
      </span>
    );
  }
  if (row.actionKind === 'forward') {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-xs">
        <ArrowRight className="h-3 w-3 text-[var(--color-muted-foreground)]" aria-hidden />
        forward → {row.actionTarget ?? '?'}
      </span>
    );
  }
  if (row.actionKind === 'worker') {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-xs">
        <ArrowRight className="h-3 w-3 text-[var(--color-muted-foreground)]" aria-hidden />
        worker → {row.actionTarget ?? '?'}
        {row.externalWorkerName ? (
          <Badge variant="outline" className="ml-1">
            external worker
          </Badge>
        ) : null}
      </span>
    );
  }
  if (row.actionKind === 'drop') {
    return <span className="font-mono text-xs">drop</span>;
  }
  if (row.actionKind === 'polaris-default') {
    return (
      <span className="text-xs text-[var(--color-muted-foreground)]">
        → Polaris (falls through to catch-all)
      </span>
    );
  }
  // unknown — render whatever the action type was so we never crash on
  // a future CF action.
  return (
    <span className="font-mono text-xs">{row.actionTarget ? `?:${row.actionTarget}` : '?'}</span>
  );
}

export function RoutesCard({ domainId, domainName }: { domainId: string; domainName: string }) {
  const receiversQ = useAdminQuery<{ data: ReceiverRow[] }>(
    domainKeys.receivers(domainId),
    `/api/admin/domains/${domainId}/receivers`,
  );
  const zoneQ = useAdminQuery<{ data: CfZoneStatusLite }>(
    cfZoneKeys.detail(domainName),
    `/api/admin/cf-zones/${encodeURIComponent(domainName)}`,
    { staleTime: 60_000 },
  );
  const cfCredsMissing =
    zoneQ.error instanceof ApiError && zoneQ.error.code === 'cf_credentials_missing';
  // CF errors degrade gracefully — Polaris is the primary data source.
  const cfErrorMessage =
    !cfCredsMissing && zoneQ.error instanceof Error ? zoneQ.error.message : null;

  const receivers = receiversQ.data?.data ?? [];
  const namedRules = zoneQ.data?.data.named_rules ?? [];
  const rows = toUnifiedRoutes(receivers, namedRules, domainName);

  const polarisRoutedCfCount = namedRules.filter((r) => r.routes_to_polaris).length;
  const isLoading = receiversQ.isLoading || zoneQ.isLoading;

  return (
    <section className="rounded-md border border-[var(--color-border)] p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <span className="text-[var(--color-muted-foreground)]" aria-hidden>
            <Route className="h-4 w-4" />
          </span>
          Routes
        </h2>
        {rows.length > 0 ? (
          <span className="text-xs text-[var(--color-muted-foreground)]">{rows.length} total</span>
        ) : null}
      </div>
      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : receiversQ.error ? (
        <ErrorText error={receiversQ.error} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Route className="h-5 w-5" />}
          title="No routes configured"
          description="Add a receiver from a mailbox detail page, or create a Cloudflare Email Routing rule in the CF dashboard."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[6rem]">Source</TableHead>
              <TableHead className="w-[6rem]">Status</TableHead>
              <TableHead>Pattern</TableHead>
              <TableHead>Action</TableHead>
              <TableHead className="w-[5rem]">Priority</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key}>
                <TableCell>
                  <span className="inline-flex items-center gap-1">
                    <Badge variant={row.source === 'polaris' ? 'success' : 'outline'}>
                      {row.source === 'polaris' ? 'polaris' : 'external'}
                    </Badge>
                    {row.frontedByCf ? (
                      <Badge
                        variant="outline"
                        className="text-[10px]"
                        title={`Fronted by CF rule "${row.frontedByCf}"`}
                      >
                        via CF
                      </Badge>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell>
                  <Badge variant={row.enabled ? 'success' : 'secondary'}>
                    {row.enabled ? 'active' : 'disabled'}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {row.patternIsMissing ? (
                    <span className="italic text-[var(--color-muted-foreground)]">
                      {row.displayPattern}
                    </span>
                  ) : (
                    row.displayPattern
                  )}
                </TableCell>
                <TableCell>
                  <ActionCell row={row} />
                </TableCell>
                <TableCell className="text-xs text-[var(--color-muted-foreground)]">
                  {row.priority ?? '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--color-muted-foreground)]">
        <span>
          {polarisRoutedCfCount > 0
            ? `${polarisRoutedCfCount} CF rule${polarisRoutedCfCount === 1 ? '' : 's'} route mail to Polaris for matching`
            : null}
          {cfCredsMissing
            ? 'External CF routes unavailable: CF_API_TOKEN missing.'
            : cfErrorMessage
              ? `External CF routes unavailable: ${cfErrorMessage}`
              : null}
        </span>
        <a
          href="https://dash.cloudflare.com/?to=/:account/email-service/routing"
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 underline hover:text-[var(--color-foreground)]"
        >
          Manage external rules in Cloudflare
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      </div>
    </section>
  );
}
