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
 *     deregister` rows from the chained audit_log.
 *
 * Auto-refresh: the heartbeat query polls every 30s so the liveness
 * badge updates without a manual reload.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Activity as ActivityIcon, History, KeyRound, Settings } from 'lucide-react';
import { PageCard } from '../../layouts/PageCard.js';
import { Button } from '../../components/ui/button.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
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
import {
  clearFreshBridgeSecrets,
  readFreshBridgeSecrets,
  type FreshBridgeSecrets,
} from './freshBridgeKey.js';

type TabValue = 'overview' | 'activity' | 'connection' | 'audit';

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

interface HeartbeatSnapshot {
  liveness: 'live' | 'stale' | 'offline';
  bridge_version: string | null;
  last_heartbeat_at: string | null;
  last_seen_at: string | null;
  payload: {
    schema_version: 1;
    bridge_version: string;
    uptime_seconds: number;
    imap_sessions_active: number;
    smtp_submissions_24h: number;
    errors_24h: number;
    mirror_message_count: number;
    reported_at: string;
  } | null;
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
  return v === 'overview' || v === 'activity' || v === 'connection' || v === 'audit';
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

  // Auto-clear the fresh key once the bridge has phoned home — at that
  // point the snippets in the Connection tab no longer need to display
  // the plaintext, and we want to keep its lifetime as short as we can.
  useEffect(() => {
    if (freshSecrets && hasEverConnected) {
      clearFreshBridgeSecrets(id);
      setFreshSecrets(null);
    }
  }, [freshSecrets, hasEverConnected, id]);

  const [confirmDereg, setConfirmDereg] = useState(false);
  const [confirmHardDelete, setConfirmHardDelete] = useState(false);
  const dereg = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/bridges/${id}`, method: 'DELETE' }),
    { invalidateKeys: [bridgeKeys.all], successMessage: 'Bridge deregistered.' },
  );
  const hardDelete = useAdminMutation<{ id: string; deleted: boolean }, undefined>(
    () => ({ path: `/api/admin/bridges/${id}?hard=true`, method: 'DELETE' }),
    {
      invalidateKeys: [bridgeKeys.all],
      successMessage: 'Bridge permanently deleted.',
      silent: true,
    },
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
            <StatusBadge kind="bridge" value="deregistered" />
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
          <Button size="sm" variant="destructive" onClick={() => setConfirmHardDelete(true)}>
            Delete permanently
          </Button>
        ) : (
          <Button size="sm" variant="destructive" onClick={() => setConfirmDereg(true)}>
            Deregister
          </Button>
        )
      }
    >
      <div className="space-y-6">
        {/* ---------- freshly-registered banner ----------
            Shown only when the operator arrived here from the Add-bridge
            dialog and the bridge hasn't checked in yet. Surfaces the
            one-time HMAC key + a brief checklist. Disappears as soon as
            the bridge phones home (the useEffect above clears
            freshKey). */}
        {freshSecrets && !hasEverConnected ? (
          <section
            className="rounded-md border border-[var(--color-border)] p-4"
            style={{
              background: 'color-mix(in oklch, var(--color-card) 88%, var(--color-success) 12%)',
            }}
          >
            <div className="flex items-start gap-3">
              <KeyRound className="h-5 w-5 text-[var(--color-success)]" aria-hidden />
              <div className="min-w-0 flex-1 space-y-3">
                <div className="font-semibold">Bridge registered — one-shot credentials below</div>
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  These values are shown ONCE. They disappear as soon as the bridge phones home, or
                  as soon as you dismiss this banner. If you lose them, rotate the bridge from this
                  page to mint a new set.
                </p>

                {freshSecrets.installerUrl ? (
                  <div className="space-y-1">
                    <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted-foreground)]">
                      One-shot install (curl | sh)
                    </div>
                    <CodeBlock code={`curl -fsSL ${freshSecrets.installerUrl} | sh`} />
                    <p className="text-xs text-[var(--color-muted-foreground)]">
                      Run on the bridge host. The URL is good for 1 hour and consumed on first
                      fetch. The script writes <span className="font-mono">docker-compose.yml</span>
                      , <span className="font-mono">docker-compose.env</span>, and{' '}
                      <span className="font-mono">./secrets/*</span>, then{' '}
                      <span className="font-mono">docker compose up -d</span> and tails the logs.
                    </p>
                  </div>
                ) : null}

                <div className="space-y-1">
                  <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted-foreground)]">
                    HMAC key
                  </div>
                  <CodeBlock code={freshSecrets.hmacKey} />
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
                    I've saved them
                  </Button>
                  <span className="text-xs text-[var(--color-muted-foreground)]">
                    The Connection tab below also carries these values for the manual flow.
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
              <MetaRow label="Last seen">
                <When iso={d.last_seen_at} />
              </MetaRow>
              <MetaRow label="Last heartbeat">
                <When iso={d.last_heartbeat_at} />
              </MetaRow>
              <MetaRow label="Serves">
                {d.serves_mailboxes} mailbox{d.serves_mailboxes === 1 ? '' : 'es'}
              </MetaRow>
              {disabled ? (
                <MetaRow label="Deregistered">
                  <When iso={d.disabled_at} />
                </MetaRow>
              ) : null}
            </MetaList>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <StatTile label="IMAP sessions" value={hb?.imap_sessions_active ?? '—'} />
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
            <StatTile label="Mirror rows" value={hb?.mirror_message_count ?? '—'} />
            <StatTile
              label="Errors (24h)"
              value={hb?.errors_24h ?? '—'}
              className={hb && hb.errors_24h > 0 ? 'border-[var(--color-warning)]' : undefined}
            />
          </div>
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
            />
          </TabsContent>

          <TabsContent value="audit">
            <BridgeAuditCard bridgeId={d.id} />
          </TabsContent>
        </Tabs>
      </div>

      <DestructiveActionDialog
        open={confirmDereg}
        onOpenChange={setConfirmDereg}
        action="Deregister bridge"
        name={d.name}
        blastRadius={[
          'The bridge is soft-disabled; the HMAC key is rejected on subsequent requests',
          'Active SMTP/IMAP sessions on the bridge will fail their next authenticated call',
          'Inbound webhooks targeting this bridge will return 401 until reregistered',
        ]}
        reversible={false}
        confirmLabel="Deregister"
        onConfirm={async () => {
          await dereg.mutateAsync(undefined);
          setConfirmDereg(false);
        }}
        isPending={dereg.isPending}
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
              ? `${hb.imap_sessions_active} IMAP session${hb.imap_sessions_active === 1 ? '' : 's'}`
              : 'Open to grab setup snippets'
          }
          onOpen={onOpenConnection}
        />
        <OverviewMiniCard
          icon={<History className="h-4 w-4" aria-hidden />}
          label="Audit"
          primary="Recent operator changes"
          secondary="Register, rotate, deregister"
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
