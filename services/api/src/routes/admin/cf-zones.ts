// Admin CF-zone discovery + configure endpoints.
//
// Pulls every zone in the operator's Cloudflare account and reports per-zone
// status across six checks (Email Routing on, MX/SPF locked by CF, sender
// onboarded, catch-all → polaris-mail-in, D1 mailbox row present). The
// `configure` endpoint computes the diff and either dry-runs it (default)
// or applies it via Cloudflare's auto-publish endpoints
// (POST /email/routing/enable + POST /email-service/sender-domains) so CF
// owns the DNS lifecycle. Manual DNS edits via dns.ts are reserved for
// non-CF-DNS edge cases (handled inside packages/cf-api).
//
// Distinct from the existing `/v1/admin/zones` endpoint which lists rows
// from the D1 `zones` table (the internal mirror that mail_domains.zone_id
// FKs into). These endpoints sit at `/v1/admin/cf-zones`.
import { Hono } from 'hono';
import {
  CloudflareApiClient,
  applyDiff,
  computeDiff,
  inspectAllZones,
  inspectZone,
  type ApplyEnv,
  type InspectorEnv,
  type ZoneDomainStatus,
} from '@polaris-mail/cf-api';
import { ulid } from '@polaris-mail/ids';
import { actorOf, audit } from '../../audit.js';
import { bodyText, requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const cfZones = new Hono<{ Bindings: Env }>();

const DEFAULT_INBOUND_WORKER = 'polaris-mail-in';
const LIST_CACHE_TTL_MS = 60_000;

interface CachedListing {
  fetched_at: number;
  data: ZoneDomainStatus[];
}

// Module-scope per-isolate cache. CF zone listings can be expensive (one
// API call per zone for inspect); 60s is enough to absorb panel re-renders
// without staleness biting an operator who just hit Apply.
let listCache: CachedListing | null = null;

function makeClient(env: Env): CloudflareApiClient | { error: Response } {
  // Defer the error response construction to keep the happy path branchless.
  // 503 + retryable:false so the panel surfaces this as a "config needed"
  // empty state rather than retrying as if the API were transiently down.
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
    return {
      error: new Response(
        JSON.stringify({
          error: {
            code: 'cf_credentials_missing',
            message:
              'CF_API_TOKEN and CF_ACCOUNT_ID must be configured via `polaris-mail setup infra secrets seed`.',
            retryable: false,
          },
        }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      ),
    };
  }
  return new CloudflareApiClient({
    apiToken: env.CF_API_TOKEN,
    accountId: env.CF_ACCOUNT_ID,
  });
}

function makeInspectorEnv(env: Env): InspectorEnv {
  return {
    inboundWorkerName: env.WORKER_NAME_INBOUND ?? DEFAULT_INBOUND_WORKER,
    async d1HasMailDomain(zoneName: string): Promise<boolean> {
      const row = await env.DB.prepare(
        `SELECT 1 AS x FROM mail_domains WHERE name = ? AND disabled_at IS NULL LIMIT 1`,
      )
        .bind(zoneName)
        .first<{ x: number }>();
      return row !== null;
    },
  };
}

function makeApplyEnv(env: Env): ApplyEnv {
  const insp = makeInspectorEnv(env);
  return {
    ...insp,
    async d1InsertMailDomain(zoneName: string): Promise<void> {
      // Mirror the shape of the create path in routes/admin/domains.ts:
      // ensure a `zones` row exists (synthesise one when CF zone id is
      // unknown to this code path), then insert mail_domains.
      const id = ulid();
      const nowIso = new Date().toISOString();
      const cfPlaceholder = `cf-${id}`; // configure caller has the real cf_zone_id but
      // doesn't thread it through; ensureZone resolves by name later if needed.
      const zoneRow = await env.DB.prepare(`SELECT id FROM zones WHERE name = ? LIMIT 1`)
        .bind(zoneName)
        .first<{ id: string }>();
      let zoneId: string;
      if (zoneRow) {
        zoneId = zoneRow.id;
      } else {
        zoneId = ulid();
        await env.DB.prepare(
          `INSERT INTO zones (id, cf_zone_id, name, created_at) VALUES (?, ?, ?, ?)`,
        )
          .bind(zoneId, cfPlaceholder, zoneName, nowIso)
          .run();
      }
      await env.DB.prepare(
        `INSERT INTO mail_domains
           (id, zone_id, name, status, wildcard_subdomains, dmarc_policy,
            dmarc_rua, inbound_enabled, outbound_enabled, provider, dkim_selector,
            created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 1, 'none', ?, 1, 1, 'cloudflare', 'cf', ?, ?)`,
      )
        .bind(id, zoneId, zoneName, `mailto:postmaster@${zoneName}`, nowIso, nowIso)
        .run();
    },
  };
}

// ---------- GET /v1/admin/cf-zones ----------
// Lists every zone in the operator's CF account with per-zone status.
// 60s in-Worker cache; pass ?refresh=1 to bypass.
cfZones.get('/v1/admin/cf-zones', requireScope('admin:read'), async (c) => {
  const made = makeClient(c.env);
  if ('error' in made) return made.error;
  const refresh = c.req.query('refresh') === '1';
  if (!refresh && listCache && Date.now() - listCache.fetched_at < LIST_CACHE_TTL_MS) {
    return c.json({
      data: listCache.data,
      fetched_at: new Date(listCache.fetched_at).toISOString(),
      cached: true,
    });
  }
  const data = await inspectAllZones(made, makeInspectorEnv(c.env));
  listCache = { fetched_at: Date.now(), data };
  return c.json({
    data,
    fetched_at: new Date(listCache.fetched_at).toISOString(),
    cached: false,
  });
});

// ---------- GET /v1/admin/cf-zones/:name ----------
// Refresh + return single-zone status. Bypasses the list cache entirely
// (operators expect fresh data after clicking Apply).
cfZones.get('/v1/admin/cf-zones/:name', requireScope('admin:read'), async (c) => {
  const made = makeClient(c.env);
  if ('error' in made) return made.error;
  const name = c.req.param('name');
  // Find the zone by name in the CF account (zone listing is scoped via
  // /zones?account.id=... per packages/cf-api/src/zones.ts).
  const all = await inspectAllZones(made, makeInspectorEnv(c.env));
  const found = all.find((z) => z.zone.name === name);
  if (!found) return buildError(c, 'not_found', `no CF zone named ${name} in this account`);
  // Refresh the just-listed zone (inspectAllZones already inspected, but
  // re-inspect to bypass any per-call memoization we may add later).
  const refreshed = await inspectZone(made, found.zone, makeInspectorEnv(c.env));
  return c.json({ data: refreshed });
});

// ---------- POST /v1/admin/cf-zones/:name/configure ----------
// Body: { dry_run?: boolean (default true), op_kinds?: ZoneConfigureOpKind[] }
// dry_run=true → return the diff without applying.
// dry_run=false → apply the diff (or just the listed op_kinds). The panel
// gates this client-side via DestructiveActionDialog; CLI/SDK callers use
// the admin key directly.
cfZones.post('/v1/admin/cf-zones/:name/configure', requireScope('admin:rotate'), async (c) => {
  const made = makeClient(c.env);
  if ('error' in made) return made.error;
  const name = c.req.param('name');

  let body: { dry_run?: boolean; op_kinds?: string[] } = {};
  const text = bodyText(c);
  if (text) {
    try {
      body = JSON.parse(text) as typeof body;
    } catch (e) {
      return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid json');
    }
  }
  const dryRun = body.dry_run !== false; // default true
  const inboundWorkerName = c.env.WORKER_NAME_INBOUND ?? DEFAULT_INBOUND_WORKER;
  const insp = makeInspectorEnv(c.env);

  const all = await inspectAllZones(made, insp);
  const found = all.find((z) => z.zone.name === name);
  if (!found) return buildError(c, 'not_found', `no CF zone named ${name} in this account`);
  const status = await inspectZone(made, found.zone, insp);

  // computeDiff is pure; selecting a subset of ops is filter+rebuild.
  const fullDiff = computeDiff(status, { inboundWorkerName });
  const selectedOps = body.op_kinds
    ? fullDiff.ops.filter((op) => body.op_kinds!.includes(op.kind))
    : fullDiff.ops;
  const diff = { ...fullDiff, ops: selectedOps };

  if (dryRun) {
    return c.json({ dry_run: true, diff });
  }

  // Bust the listing cache before applying so the next GET reflects the
  // post-apply state even if our own apply succeeded.
  listCache = null;

  const result = await applyDiff(made, diff, makeApplyEnv(c.env));
  await audit(c.env, {
    actor: actorOf(c),
    action: 'cf_zone.configure',
    target: name,
    meta: {
      applied_ops: result.applied.map((o) => o.kind),
      failed_ops: result.failed.map((f) => ({ kind: f.op.kind, error: f.error })),
    },
  });
  return c.json({
    dry_run: false,
    diff,
    result: {
      applied: result.applied,
      failed: result.failed,
      all_succeeded: result.failed.length === 0,
    },
  });
});

// Test-only: clear the in-memory cache so consecutive tests start fresh.
// Safe to expose at module level; CF only sees /v1/admin/cf-zones/* requests.
export function _resetCfZoneListCache(): void {
  listCache = null;
}
