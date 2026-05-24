// Domains list — GET /v1/admin/domains. Inbound/outbound toggles and DKIM
// rotate live on the detail page, but the initial create + the inbound/outbound
// defaults are wired here.
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
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
import { Switch } from '../../components/ui/switch.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../components/ui/dialog.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { cfZoneKeys, domainKeys } from '../../queryKeys.js';
import { apiFetch, ApiError } from '../../lib/api.js';
import { ErrorText } from '../../components/ErrorText.js';
import { EmptyState } from '../../components/EmptyState.js';
import { CompositeInput } from '../../components/CompositeInput.js';
import { FormField } from '../../components/FormField.js';

interface CfZoneRowLite {
  zone: { id: string; name: string };
  overall?: 'ok' | 'partial' | 'unconfigured' | 'error';
}

// CF zone listings are slow (CF inspects every zone). 5min staleTime keeps
// the dropdown instantaneous across panel navigations while still picking
// up newly-added zones within a single session.
const CF_ZONE_STALE_MS = 5 * 60_000;

interface DomainRow {
  id: string;
  name: string;
  status: 'pending' | 'verified' | 'failed' | 'disabled' | string;
  dkim_selector: string | null;
  inbound_enabled?: number;
  outbound_enabled?: number;
  cf_zone_id?: string | null;
}

// Worst-of composite: surface the most severe condition between verification
// and CF zone health so the operator sees one signal in the list. Operator-
// explicit terminal states (`disabled`, `failed`) and verification-in-flight
// (`pending`) take precedence — they describe what Polaris is doing — and
// only when verification is healthy do we surface CF zone issues.
function compositeDomainStatus(
  verification: string,
  zoneOverall: 'ok' | 'partial' | 'unconfigured' | 'error' | undefined,
): string {
  if (verification === 'disabled') return 'disabled';
  if (verification === 'failed') return 'failed';
  if (verification === 'pending') return 'pending';
  if (!zoneOverall) return verification;
  if (zoneOverall === 'error') return 'error';
  if (zoneOverall === 'unconfigured') return 'unconfigured';
  if (zoneOverall === 'partial') return 'partial';
  return verification;
}

function AddDomainDialog() {
  const [open, setOpen] = useState(false);
  // Domain is `<subdomain>.<zone>` (or just `<zone>` when subdomain is empty).
  // Splitting the input means the operator never types the apex twice and
  // never typos the TLD.
  const [subdomain, setSubdomain] = useState('');
  const [zoneName, setZoneName] = useState('');
  // Defaults match the backend: outbound on (the common case for issuing
  // senders), inbound off until the operator opts in.
  const [inbound, setInbound] = useState(false);
  const [outbound, setOutbound] = useState(true);

  // Pull live CF zones for the operator's account. Cached 5min so the
  // dropdown is instant on revisit. If the endpoint returns
  // cf_credentials_missing (503) the picker degrades to a single free-text
  // hostname input.
  const zones = useAdminQuery<{ data: CfZoneRowLite[] }>(cfZoneKeys.list(), '/api/admin/cf-zones', {
    staleTime: CF_ZONE_STALE_MS,
  });
  const cfCredsMissing =
    zones.error instanceof ApiError && zones.error.code === 'cf_credentials_missing';
  const zoneRows = zones.data?.data ?? [];

  // Default to the first zone — operators with one CF account/zone never have
  // to interact with the selector. Multi-zone operators still see the picker.
  // Depend on the first zone's name (stable across renders when the query
  // result is the same) rather than the `zoneRows` array (which is a fresh
  // `??[]` allocation every render).
  const firstZoneName = zones.data?.data[0]?.zone.name;
  useEffect(() => {
    if (!zoneName && firstZoneName) {
      setZoneName(firstZoneName);
    }
  }, [zoneName, firstZoneName]);

  // Hostname for the manual-entry fallback (when CF zones unavailable).
  const [manualHostname, setManualHostname] = useState('');

  const composedDomain = cfCredsMissing
    ? manualHostname.trim()
    : subdomain.trim()
      ? `${subdomain.trim()}.${zoneName}`
      : zoneName;

  // The CF zone id lets the backend populate `mail_domains.cf_zone_id`
  // at create time, which is what the verify check's
  // `cf-email-routing-dns` test reads. The selectedZone object comes
  // straight from the /api/admin/cf-zones dropdown — sending the id
  // means the backend never has to round-trip to CF to resolve it.
  const selectedZone = zoneRows.find((z) => z.zone.name === zoneName);

  const create = useAdminMutation<{ id: string }, { name: string; cf_zone_id?: string }>(
    // dkim_selector intentionally omitted — backend defaults to `polaris1`
    // which is what we want. Operators can rotate via Domain Detail later.
    (vars) => ({ path: '/api/admin/domains', method: 'POST', body: vars }),
    { invalidateKeys: [domainKeys.all], silent: true },
  );

  const reset = () => {
    setSubdomain('');
    setZoneName(zoneRows[0]?.zone.name ?? '');
    setManualHostname('');
    setInbound(false);
    setOutbound(true);
    create.reset();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="icon" title="Add domain" aria-label="Add domain">
          <Plus className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add domain</DialogTitle>
          <DialogDescription>
            The mail domain is composed as <code className="font-mono">subdomain.zone</code>. Leave
            the subdomain empty to register the apex.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {cfCredsMissing ? (
            <>
              <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-muted)] p-2 text-xs text-[var(--color-muted-foreground)]">
                CF zone autopopulate unavailable (CF_API_TOKEN missing). Enter the full hostname.
              </p>
              <FormField id="dom-host" label="Mail domain">
                <Input
                  id="dom-host"
                  value={manualHostname}
                  onChange={(e) => setManualHostname(e.target.value)}
                  placeholder="mail.acme.example"
                  autoComplete="off"
                  spellCheck={false}
                />
              </FormField>
            </>
          ) : (
            <div>
              <Label>Mail domain</Label>
              <CompositeInput
                leftValue={subdomain}
                onLeftChange={setSubdomain}
                leftPlaceholder="(optional)"
                separator="."
                rightValue={zoneName}
                onRightChange={setZoneName}
                rightOptions={zoneRows.map((z) => ({ value: z.zone.name, label: z.zone.name }))}
                rightLoading={zones.isLoading}
                rightLoadingPlaceholder="Loading zones…"
                rightPlaceholder="Pick a zone"
                previewLabel="Will register"
                preview={composedDomain || '—'}
              />
            </div>
          )}
          <div className="flex items-center gap-2">
            <Switch id="dom-in" checked={inbound} onCheckedChange={setInbound} />
            <Label htmlFor="dom-in">Enable inbound (accept mail for this domain)</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="dom-out" checked={outbound} onCheckedChange={setOutbound} />
            <Label htmlFor="dom-out">Enable outbound (allow this domain in From)</Label>
          </div>
          <ErrorText error={create.error} />
        </div>
        <DialogFooter>
          <Button
            size="sm"
            disabled={!composedDomain || create.isPending}
            onClick={async () => {
              const r = await create.mutateAsync({
                name: composedDomain,
                cf_zone_id: selectedZone?.zone.id,
              });
              // The create endpoint defaults to inbound=0, outbound=1. Fire the
              // toggle endpoints only if the operator picked something else.
              const toggles: Array<Promise<unknown>> = [];
              if (inbound) {
                toggles.push(
                  apiFetch(`/api/admin/domains/${r.id}/inbound/enable`, { method: 'POST' }),
                );
              }
              if (!outbound) {
                toggles.push(
                  apiFetch(`/api/admin/domains/${r.id}/outbound/disable`, { method: 'POST' }),
                );
              }
              if (toggles.length > 0) {
                try {
                  await Promise.all(toggles);
                } catch {
                  /* swallow — toggles can be retried on detail */
                }
              }
              setOpen(false);
              reset();
            }}
          >
            {create.isPending ? 'Adding…' : 'Add domain'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DomainsList() {
  const q = useAdminQuery<{ data: DomainRow[] }>(domainKeys.list(), '/api/admin/domains');
  // Bulk CF zone status feeds the composite Status badge below. The same
  // query is used by the AddDomainDialog above, so React Query will dedupe.
  // CF inspection is slow per-zone; cached 5 min like the dialog uses it.
  const zones = useAdminQuery<{ data: CfZoneRowLite[] }>(cfZoneKeys.list(), '/api/admin/cf-zones', {
    staleTime: CF_ZONE_STALE_MS,
  });
  const zoneOverallById = new Map<string, CfZoneRowLite['overall']>();
  for (const z of zones.data?.data ?? []) {
    if (z.overall) zoneOverallById.set(z.zone.id, z.overall);
  }
  const rows = q.data?.data ?? [];
  return (
    <PageCard
      title="Domains"
      description="Sender/recipient domain registry."
      decorative
      actions={<AddDomainDialog />}
    >
      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No domains registered"
          description="Register a sender or recipient domain before issuing senders or accepting inbound mail."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Domain</TableHead>
              <TableHead>Inbound</TableHead>
              <TableHead>Outbound</TableHead>
              <TableHead>DKIM</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <Link to="/domains/$id" params={{ id: r.id }} className="underline">
                    {r.name}
                  </Link>
                </TableCell>
                <TableCell>{r.inbound_enabled ? 'on' : 'off'}</TableCell>
                <TableCell>{r.outbound_enabled ? 'on' : 'off'}</TableCell>
                <TableCell className="font-mono text-xs">{r.dkim_selector ?? '—'}</TableCell>
                <TableCell>
                  {(() => {
                    const zoneOverall = r.cf_zone_id
                      ? zoneOverallById.get(r.cf_zone_id)
                      : undefined;
                    const composite = compositeDomainStatus(r.status, zoneOverall);
                    return (
                      <span
                        title={`verification: ${r.status}${zoneOverall ? ` · zone: ${zoneOverall}` : ''}`}
                      >
                        <StatusBadge kind="domain" value={composite} />
                      </span>
                    );
                  })()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PageCard>
  );
}
