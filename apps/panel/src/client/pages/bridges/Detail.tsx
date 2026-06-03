/*
 * Bridge detail — first-class redesign.
 *
 * Why the rewrite:
 *   - Pre-rewrite: 130 lines. Title + StatusBadge + 2 buttons + "Last
 *     seen: never" (literal — `bridges.last_seen_at` was never written).
 *     Operators had no recourse from the page itself: no message
 *     activity, no audit feed, no setup snippets they could re-copy.
 *   - This page mirrors the mailbox/domain Detail pattern: persistent
 *     header strip (title + liveness + actions), 2-col identity + stats
 *     grid, tabs deep-linkable via `?tab=`.
 *
 * What each tab covers:
 *   - Overview  → mini-cards linking to other tabs + an "offline" callout
 *     when the bridge has missed its heartbeat window.
 *   - Activity  → MessagesListView scoped by `messages.bridge_id`.
 *   - Connection→ persistent BridgeConnectionCard with all five snippet
 *     variants. HMAC key is `<paste-HMAC-key-here>` unless the operator
 *     rotates from this tab.
 *   - Audit     → BridgeAuditCard pulling `bridge.register/rotate/
 *     disable/enable` rows from the chained audit_log.
 *
 * Auto-refresh: the heartbeat query polls every 30s so the liveness
 * badge updates without a manual reload.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Activity as ActivityIcon, History, KeyRound, Settings } from 'lucide-react';
import { PageCard } from '../../layouts/PageCard.js';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { StatTile } from '../../components/StatTile.js';
import { MetaList, MetaRow } from '../../components/MetaList.js';
import { CodeBlock } from '../../components/CodeBlock.js';
import { DestructiveActionDialog } from '../../components/DestructiveActionDialog.js';
import { ErrorText } from '../../components/ErrorText.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { bridgeKeys } from '../../queryKeys.js';
import { formatDate, formatDuration, formatRelative } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import { MessagesListView } from '../messages/MessagesListView.js';
import { BridgeAuditCard } from './BridgeAuditCard.js';
import { BridgeConnectionCard } from './BridgeConnectionCard.js';
import { BridgeLogsCard } from './BridgeLogsCard.js';
import { BridgeSettingsCard } from './BridgeSettingsCard.js';
import {
  clearFreshBridgeSecrets,
  readFreshBridgeSecrets,
  stashFreshBridgeSecrets,
  type FreshBridgeSecrets,
} from './freshBridgeKey.js';

type TabValue = 'overview' | 'activity' | 'connection' | 'settings' | 'logs' | 'audit';

interface BridgeDetail {
  id: string;
  name: string;
  last_seen_at: string | null;
  created_at: string;
  disabled_at: string | null;
  bridge_version: string | null;
  liveness: 'live' | 'stale' | 'offline';
  serves_mailboxes: number;
  last_heartbeat_at: string | null;
}

interface HeartbeatV2Payload {
  schema_version: 2;
  bridge_version: string;
  uptime_seconds: number;
  reported_at: string;
  node: {
    hostname: string;
    os: string;
    arch: string;
    container_id: string | null;
    tailnet_node_id: string | null;
  };
  services: {
    smtp: { listening: boolean; port: number; sessions_active: number; errors_24h: number };
    imap: { listening: boolean; port: number; sessions_active: number; errors_24h: number };
    webhook_receiver: { deliveries_24h: number; errors_24h: number };
  };
  acme: {
    fqdn: string;
    cert_not_after: string | null;
    last_renew_attempt_at: string | null;
    last_renew_status: 'ok' | 'failed' | 'pending' | null;
  };
  mirror: { message_count: number; lag_seconds: number; last_sync_at: string | null };
  recent_errors: { at: string; code: string; message: string }[];
}

interface HeartbeatSnapshot {
  liveness: 'live' | 'stale' | 'offline';
  bridge_version: string | null;
  last_heartbeat_at: string | null;
  last_seen_at: string | null;
  payload: HeartbeatV2Payload | null;
}

interface ActivityRollup {
  bridge_id: string;
  window: '24h';
  totals: {
    submitted: number;
    delivered: number;
    failed: number;
    bounced: number;
    inflight: number;
  };
  latest_message: { id: string; subject: string | null; status: string; created_at: string } | null;
}

const HEARTBEAT_REFETCH_MS = 30_000;

function isTab(v: unknown): v is TabValue {
  return (
    v === 'overview' ||
    v === 'activity' ||
    v === 'connection' ||
    v === 'settings' ||
    v === 'logs' ||
    v === 'audit'
  );
}

function When({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-[var(--color-muted-foreground)]">—</span>;
  return <span title={formatDate(iso)}>{formatRelative(iso)}</span>;
}

export function BridgeDetail() {
  const { id } = useParams({ from: '/bridges/$id' });
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tab?: string };

  const detail = useAdminQuery<BridgeDetail>(bridgeKeys.detail(id), `/api/admin/bridges/${id}`, {
    refetchInterval: HEARTBEAT_REFETCH_MS,
  });
  const heartbeat = useAdminQuery<HeartbeatSnapshot>(
    bridgeKeys.heartbeat(id),
    `/api/admin/bridges/${id}/heartbeat`,
    { refetchInterval: HEARTBEAT_REFETCH_MS },
  );
  const activity = useAdminQuery<ActivityRollup>(
    bridgeKeys.activity(id),
    `/api/admin/bridges/${id}/activity`,
  );

  // Read the just-minted secret bundle (HMAC key + optional TS auth
  // key + one-shot installer URL) if the operator arrived here via
  // the Add-bridge dialog. Cleared once the bridge phones home OR
  // when the operator dismisses the banner.
  const [freshSecrets, setFreshSecrets] = useState<FreshBridgeSecrets | null>(() =>
    readFreshBridgeSecrets(id),
  );
  const freshKey = freshSecrets?.hmacKey ?? null;

  // Default tab: if the bridge has never connected, drop the operator on
  // the Connection tab so the snippets are the first thing they see.
  // Otherwise default to Overview. Explicit `?tab=` always wins.
  const hasEverConnected = detail.data?.last_seen_at != null;
  const defaultTab: TabValue = hasEverConnected ? 'overview' : 'connection';
  const activeTab: TabValue = isTab(search.tab) ? search.tab : defaultTab;
  const setTab = (next: TabValue) => {
    void navigate({
      to: '/bridges/$id',
      params: { id },
      search: { tab: next === defaultTab ? undefined : next },
      replace: true,
    });
  };

  // Auto-clear the fresh secrets once the bridge has phoned home *with
  // the freshly minted HMAC* — i.e., its last_heartbeat_at is at or
  // after the mint timestamp. This handles both first-registration
  // (mintedAtMs = registration time; cleared once the bridge ever
  // connects) and re-roll on a live bridge (mintedAtMs = rotation
  // time; the previous heartbeat doesn't count, only a new one with
  // the new HMAC does).
  const lastHeartbeatMs = detail.data?.last_heartbeat_at
    ? Date.parse(detail.data.last_heartbeat_at)
    : 0;
  useEffect(() => {
    if (freshSecrets && lastHeartbeatMs >= freshSecrets.mintedAtMs && lastHeartbeatMs > 0) {
      clearFreshBridgeSecrets(id);
      setFreshSecrets(null);
    }
  }, [freshSecrets, lastHeartbeatMs, id]);

  const [confirmDisable, setConfirmDisable] = useState(false);
  const [confirmHardDelete, setConfirmHardDelete] = useState(false);
  const [confirmRoll, setConfirmRoll] = useState(false);
  const disable = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/bridges/${id}`, method: 'DELETE' }),
    {
      invalidateKeys: [bridgeKeys.all],
      successMessage: 'Bridge disabled.',
    },
  );
  const hardDelete = useAdminMutation<{ id: string; deleted: boolean }, undefined>(
    () => ({ path: `/api/admin/bridges/${id}?hard=true`, method: 'DELETE' }),
    {
      invalidateKeys: [bridgeKeys.all],
      successMessage: 'Bridge permanently deleted.',
      silent: true,
    },
  );
  // POST /v1/admin/bridges/:id/enable — clears disabled_at. The
  // bridge's existing on-disk HMAC works again immediately; rolling
  // is only needed if the credential was lost or compromised.
  const enable = useAdminMutation<{ id: string; disabled_at: string | null }, undefined>(
    () => ({ path: `/api/admin/bridges/${id}/enable`, method: 'POST' }),
    { invalidateKeys: [bridgeKeys.all], successMessage: 'Bridge re-enabled.' },
  );
  // POST /v1/admin/bridges/:id/rotate — mints a fresh HMAC + install URL.
  // Three modes: staged (delivered via heartbeat with a grace window;
  // bridge applies seamlessly — live bridges only), now (immediate swap,
  // no grace window, operator reinstalls; enable state untouched), or
  // emergency (now + disable — operator must reinstall via curl|sh +
  // re-enable). A disabled/deregistered bridge can only roll `now`.
  type RollMode = 'staged' | 'now' | 'emergency';
  type GraceWindow = '600' | '3600' | '86400' | 'until-acked';
  const [rollMode, setRollMode] = useState<RollMode>('staged');
  const [rollGrace, setRollGrace] = useState<GraceWindow>('3600');
  const rotate = useAdminMutation<
    { hmac_key: string; installer_url: string; mode: string; grace_expires_at: string | null },
    { mode: RollMode; grace_seconds?: GraceWindow }
  >(
    ({ mode, grace_seconds }) => {
      const qs = new URLSearchParams({ mode });
      if (mode === 'staged' && grace_seconds) qs.set('grace_seconds', grace_seconds);
      return { path: `/api/admin/bridges/${id}/rotate?${qs.toString()}`, method: 'POST' };
    },
    { invalidateKeys: [bridgeKeys.detail(id)], silent: true },
  );

  const breadcrumbs = [{ label: 'Bridges', to: '/bridges' }, { label: detail.data?.name ?? id }];

  if (detail.isLoading) {
    return (
      <PageCard title="Bridge" breadcrumbs={breadcrumbs} decorative>
        <Skeleton className="h-32 w-full" />
      </PageCard>
    );
  }
  if (detail.error || !detail.data) {
    return (
      <PageCard title="Bridge" breadcrumbs={breadcrumbs} decorative>
        <ErrorText error={detail.error ?? 'Not found.'} />
      </PageCard>
    );
  }

  const d = detail.data;
  const hb = heartbeat.data?.payload ?? null;
  const totals = activity.data?.totals;
  const disabled = d.disabled_at != null;

  return (
    <PageCard
      decorative
      breadcrumbs={breadcrumbs}
      title={
        <span className="inline-flex items-center gap-2">
          {d.name}
          {disabled ? (
            <StatusBadge kind="bridge" value="disabled" />
          ) : (
            <StatusBadge kind="bridge" value={d.liveness} />
          )}
        </span>
      }
      description={
        d.bridge_version
          ? `mail-bridge ${d.bridge_version}`
          : 'Never connected — start the bridge to receive its first heartbeat.'
      }
      actions={
        disabled ? (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await enable.mutateAsync(undefined);
              }}
              disabled={enable.isPending}
            >
              {enable.isPending ? 'Enabling…' : 'Enable'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                // Disabled bridge: no live heartbeat to ack a staged
                // roll, so an immediate swap is the only sensible roll.
                setRollMode('now');
                setConfirmRoll(true);
              }}
              disabled={rotate.isPending}
            >
              {rotate.isPending ? 'Rolling…' : 'Roll HMAC Secret'}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => setConfirmHardDelete(true)}>
              Delete permanently
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setRollMode('staged');
                setConfirmRoll(true);
              }}
              disabled={rotate.isPending}
            >
              {rotate.isPending ? 'Rolling…' : 'Roll HMAC Secret'}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => setConfirmDisable(true)}>
              Disable
            </Button>
          </>
        )
      }
    >
      <div className="space-y-6">
        {/* ---------- fresh-credentials banner ----------
            Shown whenever the operator has un-installed credentials in
            sessionStorage — either right after Add-bridge or right
            after a Roll HMAC Secret. Auto-clears once the bridge
            phones home AT OR AFTER the mint time (so re-rolling a
            previously-live bridge doesn't get wiped by a stale
            heartbeat). */}
        {freshSecrets ? (
          <section
            className="rounded-md border border-[var(--color-border)] p-4"
            style={{
              background: 'color-mix(in oklch, var(--color-card) 88%, var(--color-success) 12%)',
            }}
          >
            <div className="flex items-start gap-3">
              <KeyRound className="h-5 w-5 text-[var(--color-success)]" aria-hidden />
              <div className="min-w-0 flex-1 space-y-3">
                <div className="font-semibold">
                  {hasEverConnected
                    ? 'HMAC rolled — reinstall on the host'
                    : 'Bridge registered — install on the host'}
                </div>
                {freshSecrets.installerUrl ? (
                  <div className="space-y-1">
                    <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted-foreground)]">
                      One-click install
                    </div>
                    <CodeBlock code={`curl -fsSL ${freshSecrets.installerUrl} | sh`} />
                    <p className="text-xs text-[var(--color-muted-foreground)]">
                      Run on the bridge host — auto-installs Docker, writes compose + secrets,
                      brings the bridge up.
                    </p>
                  </div>
                ) : null}

                <div className="space-y-1">
                  <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted-foreground)]">
                    HMAC key (shown ONCE)
                  </div>
                  <CodeBlock code={freshSecrets.hmacKey} />
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    The only secret you might need to keep around — for re-installing or for the
                    manual path on the Connection tab. If you lose it, roll the HMAC secret above to
                    mint a fresh one.
                  </p>
                </div>

                {/* No Tailscale auth key shown — it flows server-to-bridge
                    via /v1/bridge/config and the bootstrap init container
                    writes it to ./secrets/ts_authkey at compose-up time. */}

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      clearFreshBridgeSecrets(id);
                      setFreshSecrets(null);
                    }}
                  >
                    Dismiss
                  </Button>
                  <span className="text-xs text-[var(--color-muted-foreground)]">
                    Auto-dismisses when the bridge phones home with the new HMAC. The Connection tab
                    below has the manual install steps if you'd rather not run curl | sh.
                  </span>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {/* ---------- identity + stats strip ----------
            Two-column layout mirrors mailbox/domain detail: definition
            list on the left, telemetry tiles on the right. Tiles render
            `—` when there is no heartbeat data yet so the layout is
            stable regardless of bridge state. */}
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
          <div
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-4"
            style={{
              background: 'color-mix(in oklch, var(--color-card) 96%, var(--color-primary) 4%)',
            }}
          >
            <MetaList>
              <MetaRow label="Bridge id">
                <code className="font-mono text-xs break-all">{d.id}</code>
              </MetaRow>
              <MetaRow label="Registered">
                <When iso={d.created_at} />
              </MetaRow>
              <MetaRow label="Last heartbeat">
                <When iso={d.last_heartbeat_at ?? d.last_seen_at} />
              </MetaRow>
              {hb?.acme.fqdn ? (
                <MetaRow label="FQDN">
                  <code className="font-mono text-xs break-all">{hb.acme.fqdn}</code>
                </MetaRow>
              ) : null}
              {hb ? (
                <MetaRow label="Uptime">
                  <span title={`since ${formatDate(hb.reported_at)}`}>
                    {formatDuration(hb.uptime_seconds * 1000)}
                  </span>
                </MetaRow>
              ) : null}
              {disabled ? (
                <MetaRow label="Disabled">
                  <When iso={d.disabled_at} />
                </MetaRow>
              ) : null}
            </MetaList>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <StatTile label="IMAP sessions" value={hb?.services.imap.sessions_active ?? '—'} />
            <StatTile label="Sent (24h)" value={totals?.submitted ?? '—'} />
            <StatTile
              label="Failed (24h)"
              value={totals?.failed ?? '—'}
              className={
                totals && totals.failed > 0 ? 'border-[var(--color-destructive)]' : undefined
              }
            />
            <StatTile
              label="Uptime"
              value={hb ? formatDuration(hb.uptime_seconds * 1000) : '—'}
              mono={!hb}
            />
            <StatTile label="Mirror rows" value={hb?.mirror.message_count ?? '—'} />
            <StatTile
              label="Errors (24h)"
              value={hb ? hb.services.smtp.errors_24h + hb.services.imap.errors_24h : '—'}
              className={
                hb && hb.services.smtp.errors_24h + hb.services.imap.errors_24h > 0
                  ? 'border-[var(--color-warning)]'
                  : undefined
              }
            />
          </div>

          {hb ? (
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 lg:col-span-2 lg:grid-cols-4">
              {/* Node */}
              <section className="rounded-md border border-[var(--color-border)] p-3">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
                  Node
                </div>
                <MetaList>
                  <MetaRow label="Hostname">
                    <span className="font-mono text-xs">{hb.node.hostname}</span>
                  </MetaRow>
                  <MetaRow label="OS / arch">
                    <span className="font-mono text-xs">
                      {hb.node.os}/{hb.node.arch}
                    </span>
                  </MetaRow>
                  {hb.node.container_id ? (
                    <MetaRow label="Container">
                      <span className="font-mono text-xs">{hb.node.container_id.slice(0, 12)}</span>
                    </MetaRow>
                  ) : null}
                  {hb.node.tailnet_node_id ? (
                    <MetaRow label="Tailnet node">
                      <span className="font-mono text-xs">{hb.node.tailnet_node_id}</span>
                    </MetaRow>
                  ) : null}
                </MetaList>
              </section>

              {/* Services */}
              <section className="rounded-md border border-[var(--color-border)] p-3">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
                  Services
                </div>
                <MetaList>
                  <MetaRow label="SMTP">
                    <span className="font-mono text-xs">
                      {hb.services.smtp.listening ? 'up' : 'down'} :{hb.services.smtp.port}
                      {' · '}
                      sessions {hb.services.smtp.sessions_active}
                      {' · '}
                      errors {hb.services.smtp.errors_24h}/24h
                    </span>
                  </MetaRow>
                  <MetaRow label="IMAP">
                    <span className="font-mono text-xs">
                      {hb.services.imap.listening ? 'up' : 'down'} :{hb.services.imap.port}
                      {' · '}
                      sessions {hb.services.imap.sessions_active}
                      {' · '}
                      errors {hb.services.imap.errors_24h}/24h
                    </span>
                  </MetaRow>
                  <MetaRow label="Webhooks">
                    <span className="font-mono text-xs">
                      delivered {hb.services.webhook_receiver.deliveries_24h}/24h
                      {' · '}
                      errors {hb.services.webhook_receiver.errors_24h}/24h
                    </span>
                  </MetaRow>
                </MetaList>
              </section>

              {/* ACME */}
              <section className="rounded-md border border-[var(--color-border)] p-3">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
                  ACME / certs
                </div>
                <MetaList>
                  <MetaRow label="FQDN">
                    <span className="font-mono text-xs">{hb.acme.fqdn || '—'}</span>
                  </MetaRow>
                  <MetaRow label="Cert expiry">
                    {hb.acme.cert_not_after ? (
                      <span title={formatDate(hb.acme.cert_not_after)}>
                        {formatRelative(hb.acme.cert_not_after)}
                      </span>
                    ) : (
                      <span className="text-[var(--color-muted-foreground)]">—</span>
                    )}
                  </MetaRow>
                  <MetaRow label="Last renew">
                    {hb.acme.last_renew_status ? (
                      <span className="font-mono text-xs">{hb.acme.last_renew_status}</span>
                    ) : (
                      <span className="text-[var(--color-muted-foreground)]">—</span>
                    )}
                  </MetaRow>
                </MetaList>
              </section>

              {/* Mirror + recent errors */}
              <section className="rounded-md border border-[var(--color-border)] p-3">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
                  Mirror &amp; errors
                </div>
                <MetaList>
                  <MetaRow label="Messages">
                    <span className="font-mono text-xs">{hb.mirror.message_count}</span>
                  </MetaRow>
                  <MetaRow label="Sync lag">
                    <span className="font-mono text-xs">{hb.mirror.lag_seconds.toFixed(1)}s</span>
                  </MetaRow>
                </MetaList>
                {hb.recent_errors.length > 0 ? (
                  <div className="mt-3 max-h-32 space-y-1 overflow-auto text-xs">
                    {hb.recent_errors.slice(0, 10).map((e, i) => (
                      <div
                        key={`${e.at}-${i}`}
                        className="rounded border border-[var(--color-border)] bg-[var(--color-card)] p-1.5 font-mono"
                      >
                        <span className="text-[var(--color-muted-foreground)]">
                          {formatRelative(e.at)}
                        </span>
                        {' · '}
                        <span className="text-[var(--color-warning)]">{e.code}</span>
                        {' · '}
                        <span>{e.message}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
                    No recent errors reported.
                  </p>
                )}
              </section>
            </div>
          ) : null}
        </section>

        {/* ---------- tabs ---------- */}
        <Tabs value={activeTab} onValueChange={(v) => setTab(v as TabValue)}>
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="activity">
              Activity
              {totals && totals.submitted > 0 ? (
                <span className="ml-2 text-[var(--color-muted-foreground)]">
                  {totals.submitted}
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="connection">Connection</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="audit">Audit</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <OverviewTab
              bridge={d}
              hb={hb}
              totals={totals}
              // Suppress the offline callout when the freshly-registered
              // banner is up — duplicate noise; the banner already tells
              // the operator what to do.
              suppressOfflineCallout={freshKey != null && !hasEverConnected}
              onOpenActivity={() => setTab('activity')}
              onOpenConnection={() => setTab('connection')}
              onOpenAudit={() => setTab('audit')}
            />
          </TabsContent>

          <TabsContent value="activity">
            <MessagesListView scopedBridge={{ id: d.id, name: d.name }} />
          </TabsContent>

          <TabsContent value="connection">
            <BridgeConnectionCard
              bridgeId={d.id}
              bridgeName={d.name}
              initialHmacKey={freshKey ?? undefined}
              initialInstallerUrl={freshSecrets?.installerUrl ?? undefined}
            />
          </TabsContent>

          <TabsContent value="settings">
            <BridgeSettingsCard bridgeId={d.id} />
          </TabsContent>

          <TabsContent value="logs">
            <BridgeLogsCard bridgeId={d.id} />
          </TabsContent>

          <TabsContent value="audit">
            <BridgeAuditCard bridgeId={d.id} />
          </TabsContent>
        </Tabs>
      </div>

      <RollHMACDialog
        open={confirmRoll}
        onOpenChange={setConfirmRoll}
        bridgeName={d.name}
        disabledBridge={disabled}
        mode={rollMode}
        onModeChange={setRollMode}
        grace={rollGrace}
        onGraceChange={setRollGrace}
        isPending={rotate.isPending}
        onConfirm={async () => {
          const r = await rotate.mutateAsync(
            rollMode === 'staged'
              ? { mode: 'staged', grace_seconds: rollGrace }
              : { mode: rollMode },
          );
          setConfirmRoll(false);
          const now = Date.now();
          stashFreshBridgeSecrets(id, {
            hmacKey: r.hmac_key,
            installerUrl: r.installer_url,
            mintedAtMs: now,
          });
          setFreshSecrets({
            hmacKey: r.hmac_key,
            installerUrl: r.installer_url,
            mintedAtMs: now,
          });
          void navigate({
            to: '/bridges/$id',
            params: { id },
            search: { tab: 'connection' },
            replace: true,
          });
        }}
      />

      <DestructiveActionDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        action="Disable bridge"
        name={d.name}
        blastRadius={[
          "The bridge's HMAC key is rejected on subsequent requests",
          'Active SMTP/IMAP sessions on the bridge will fail their next authenticated call',
          'Inbound webhooks targeting this bridge will return 401 until re-enabled',
          'Reversible — re-enable from this page (the HMAC stays valid) or roll the HMAC to mint a fresh credential',
        ]}
        reversible
        confirmLabel="Disable"
        onConfirm={async () => {
          await disable.mutateAsync(undefined);
          setConfirmDisable(false);
        }}
        isPending={disable.isPending}
      />

      <DestructiveActionDialog
        open={confirmHardDelete}
        onOpenChange={setConfirmHardDelete}
        action="Permanently delete bridge"
        name={d.name}
        // Type-the-name gate — hard delete is irreversible and removes
        // the bridge row entirely. Past messages submitted via this
        // bridge keep their content but lose their bridge attribution
        // (messages.bridge_id is set to NULL). The audit log keeps
        // the bridge-id reference forever (target column is text,
        // unconstrained).
        typedConfirmation={d.name}
        blastRadius={[
          'The bridge row is removed from the database',
          'Historical messages keep their content but lose bridge attribution',
          'The bridge id can be reused by registering a new bridge with the same name',
          'The audit log entry for this bridge remains and references the now-deleted id',
        ]}
        reversible={false}
        confirmLabel="Delete permanently"
        onConfirm={async () => {
          await hardDelete.mutateAsync(undefined);
          setConfirmHardDelete(false);
          // Navigate back to the list — the detail page is about to 404.
          void navigate({ to: '/bridges' });
        }}
        isPending={hardDelete.isPending}
      />
    </PageCard>
  );
}

function OverviewTab({
  bridge,
  hb,
  totals,
  suppressOfflineCallout = false,
  onOpenActivity,
  onOpenConnection,
  onOpenAudit,
}: {
  bridge: BridgeDetail;
  hb: HeartbeatSnapshot['payload'];
  totals: ActivityRollup['totals'] | undefined;
  suppressOfflineCallout?: boolean;
  onOpenActivity: () => void;
  onOpenConnection: () => void;
  onOpenAudit: () => void;
}) {
  const offline = bridge.liveness === 'offline' && !bridge.disabled_at;
  return (
    <div className="space-y-6">
      {offline && !suppressOfflineCallout ? (
        <section
          className="flex items-start gap-3 rounded-md border border-[var(--color-border)] p-4"
          style={{
            background: 'color-mix(in oklch, var(--color-card) 88%, var(--color-warning) 12%)',
          }}
        >
          <div className="space-y-1 text-sm">
            <div className="font-semibold">
              {bridge.last_seen_at ? 'Bridge offline' : 'Bridge has never connected'}
            </div>
            <p className="text-xs text-[var(--color-muted-foreground)]">
              {bridge.last_seen_at
                ? `Last seen ${formatRelative(bridge.last_seen_at)}. The bridge has stopped sending heartbeats. Check the bridge host's logs and reachability to the API.`
                : 'Start the bridge on its host to receive the first heartbeat. The Connection tab has copy-pasteable snippets.'}
            </p>
            <p className="text-xs text-[var(--color-muted-foreground)]">
              <button
                type="button"
                className="underline hover:text-[var(--color-foreground)]"
                onClick={onOpenConnection}
              >
                Open Connection tab →
              </button>
            </p>
          </div>
        </section>
      ) : null}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <OverviewMiniCard
          icon={<ActivityIcon className="h-4 w-4" aria-hidden />}
          label="Activity (24h)"
          primary={totals ? `${totals.submitted} submitted` : '—'}
          secondary={
            totals && (totals.failed > 0 || totals.bounced > 0)
              ? `${totals.failed + totals.bounced} failed/bounced`
              : undefined
          }
          warn={totals != null && (totals.failed > 0 || totals.bounced > 0)}
          onOpen={onOpenActivity}
        />
        <OverviewMiniCard
          icon={<Settings className="h-4 w-4" aria-hidden />}
          label="Connection"
          primary={hb ? `mail-bridge ${hb.bridge_version}` : 'No heartbeat yet'}
          secondary={
            hb
              ? `${hb.services.imap.sessions_active} IMAP session${hb.services.imap.sessions_active === 1 ? '' : 's'}`
              : 'Open to grab setup snippets'
          }
          onOpen={onOpenConnection}
        />
        <OverviewMiniCard
          icon={<History className="h-4 w-4" aria-hidden />}
          label="Audit"
          primary="Recent operator changes"
          secondary="Register, roll, disable, enable"
          onOpen={onOpenAudit}
        />
      </section>
    </div>
  );
}

function OverviewMiniCard({
  icon,
  label,
  primary,
  secondary,
  warn,
  onOpen,
}: {
  icon: React.ReactNode;
  label: string;
  primary: string;
  secondary?: string;
  warn?: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-start gap-3 rounded-md border border-[var(--color-border)] p-3 text-left transition-colors hover:bg-[var(--color-muted)]"
    >
      <div
        className={cn(
          'shrink-0 rounded-md p-1.5',
          warn
            ? 'bg-[color-mix(in_oklch,var(--color-card)_82%,var(--color-warning)_18%)] text-[var(--color-warning)]'
            : 'bg-[var(--color-secondary)] text-[var(--color-muted-foreground)]',
        )}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted-foreground)]">
          {label}
        </div>
        <div className="mt-0.5 text-sm font-semibold">{primary}</div>
        {secondary ? (
          <div className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">{secondary}</div>
        ) : null}
      </div>
    </button>
  );
}

// --- Roll HMAC Secret dialog ----------------------------------------------
// Three modes the operator picks between:
//   * Staged   — server delivers the new HMAC over the next heartbeat;
//                old and new both verify for the chosen grace window.
//                Seamless from the bridge's perspective. Live-only.
//   * Now      — immediate HMAC swap, no grace window. The old key stops
//                working at once; the operator reinstalls via the new
//                URL. Enable state is untouched.
//   * Emergency — `now` PLUS disable. The operator must reinstall + re-
//                enable. Locks the bridge out NOW.
//
// A disabled/deregistered bridge has no live heartbeat to ack a staged
// roll, so the dialog collapses to a single `now` path — no mode picker,
// no grace window.
function RollHMACDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bridgeName: string;
  disabledBridge: boolean;
  mode: 'staged' | 'now' | 'emergency';
  onModeChange: (m: 'staged' | 'now' | 'emergency') => void;
  grace: '600' | '3600' | '86400' | 'until-acked';
  onGraceChange: (g: '600' | '3600' | '86400' | 'until-acked') => void;
  isPending: boolean;
  onConfirm: () => Promise<void>;
}) {
  const [typed, setTyped] = useState('');
  // Reset the emergency confirmation gate every time the dialog closes
  // so a re-open starts blank — type-to-confirm should never carry
  // state across operator dwells.
  useEffect(() => {
    if (!props.open) setTyped('');
  }, [props.open]);

  const emergencyOk = props.mode !== 'emergency' || typed === props.bridgeName;

  const confirmLabel = props.isPending
    ? 'Rolling…'
    : props.mode === 'staged'
      ? 'Roll (staged)'
      : props.mode === 'emergency'
        ? 'Roll & lock out (emergency)'
        : 'Roll now';

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Roll HMAC Secret</DialogTitle>
          <DialogDescription>
            Rotate the HMAC key for <span className="font-mono">{props.bridgeName}</span>.{' '}
            {props.disabledBridge
              ? 'This bridge is disabled, so the new key applies immediately.'
              : 'Pick a mode below.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {/* "Now" is always offered. "Staged" needs a live bridge to ack
              the roll over a heartbeat, so it's hidden for a disabled/
              deregistered node (no grace window to gain). */}
          <ToggleGroup
            type="single"
            value={props.mode}
            onValueChange={(v) => {
              if (v === 'staged' || v === 'now' || v === 'emergency') props.onModeChange(v);
            }}
            className="w-full"
          >
            {!props.disabledBridge ? (
              <ToggleGroupItem value="staged" className="flex-1">
                Staged
              </ToggleGroupItem>
            ) : null}
            <ToggleGroupItem value="now" className="flex-1">
              Now
            </ToggleGroupItem>
            <ToggleGroupItem value="emergency" className="flex-1">
              Emergency
            </ToggleGroupItem>
          </ToggleGroup>
          {props.mode === 'staged' ? (
            <div className="space-y-2 rounded-md border border-[var(--color-border)] p-3">
              <p className="text-xs text-[var(--color-muted-foreground)]">
                Server delivers the new HMAC to the bridge over the next heartbeat. Old + new HMACs
                both verify for the chosen grace window — the bridge applies seamlessly with no
                downtime.
              </p>
              <div>
                <Label htmlFor="roll-grace" className="text-xs">
                  Grace window
                </Label>
                <Select
                  value={props.grace}
                  onValueChange={(v) =>
                    props.onGraceChange(v as '600' | '3600' | '86400' | 'until-acked')
                  }
                >
                  <SelectTrigger id="roll-grace">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="600">10 minutes</SelectItem>
                    <SelectItem value="3600">1 hour (default)</SelectItem>
                    <SelectItem value="86400">24 hours</SelectItem>
                    <SelectItem value="until-acked">Until bridge acks (30d cap)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : props.mode === 'now' ? (
            <div className="space-y-2 rounded-md border border-[var(--color-border)] p-3">
              <p className="text-xs text-[var(--color-foreground)]">
                <strong>Applies the new HMAC immediately — no grace window.</strong> The current key
                stops working at once;{' '}
                {props.disabledBridge
                  ? 'the bridge stays disabled — re-enable it from this page once you reinstall with the new install URL.'
                  : 'the bridge stays enabled — reinstall on the host with the new install URL to bring it back.'}
              </p>
            </div>
          ) : (
            <div className="space-y-2 rounded-md border border-[var(--color-destructive)] p-3">
              <p className="text-xs text-[var(--color-foreground)]">
                <strong>Locks the bridge out immediately.</strong> The current HMAC stops working
                AND the bridge is disabled. Operator must reinstall via the new install URL and
                re-enable. Use only when the existing credential is believed compromised.
              </p>
              <div>
                <Label htmlFor="roll-confirm" className="text-xs">
                  Type the bridge name to confirm
                </Label>
                <Input
                  id="roll-confirm"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={props.bridgeName}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant={props.mode === 'emergency' ? 'destructive' : 'default'}
            disabled={!emergencyOk || props.isPending}
            onClick={() => void props.onConfirm()}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
