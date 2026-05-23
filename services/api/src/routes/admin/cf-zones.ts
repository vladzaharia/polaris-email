// Admin CF-zone discovery + configure endpoints.
//
// Pulls every zone in the operator's Cloudflare account and reports per-zone
// status across six checks (Email Routing on, MX/SPF locked by CF, sender
// onboarded, catch-all → polaris-mail-in, D1 mailbox row present). The
// `configure` endpoint computes the diff and either dry-runs it (default)
// or applies it via Cloudflare's auto-publish endpoints
// (POST /email/routing/enable + POST /email-service/sender-domains) so CF
// owns the DNS lifecycle.
//
// Caching has two layers:
//   * Per-isolate module-scope cache (60s) — saves repeated calls inside
//     the same Worker isolate (panel re-renders, back-to-back GETs).
//   * KV-backed shared cache (`cfz:listing`, 90min TTL) — survives Worker
//     redeploys and is shared across colos. Primed by the hourly
//     `domain-verify` cron so the panel never has to pay the cost of a
//     cold inspect (typically ≥5s for an account with several zones).
//
// `GET /v1/admin/cf-zones` and `GET /v1/admin/cf-zones/:name` both read
// through this stack. `?refresh=1` bypasses both layers and forces a
// live inspect. `POST /v1/admin/cf-zones/:name/configure` invalidates
// both caches on apply.
//
// Distinct from `/v1/admin/zones` which lists rows from the D1 `zones`
// table (the internal mirror that mail_domains.zone_id FKs into).
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
const MODULE_CACHE_TTL_MS = 60_000;
const KV_CACHE_KEY = 'cfz:listing';
// 90min KV TTL covers the 1h cron interval plus 30min of headroom for a
// missed run; after that, the next request pays the cost of a live
// inspect and re-primes the cache.
const KV_CACHE_TTL_SECONDS = 90 * 60;

interface CachedListing {
  fetched_at: number;
  data: ZoneDomainStatus[];
}

// Per-isolate L1 cache. Workers can recycle isolates at any time; the KV
// layer is the durable backstop.
let listCache: CachedListing | null = null;

function makeClient(env: Env): CloudflareApiClient | { error: Response } {
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
      const id = ulid();
      const nowIso = new Date().toISOString();
      const cfPlaceholder = `cf-${id}`;
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
            inbound_enabled, outbound_enabled, provider, dkim_selector,
            created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 1, 'none', 1, 1, 'cloudflare', 'cf', ?, ?)`,
      )
        .bind(id, zoneId, zoneName, nowIso, nowIso)
        .run();
    },
  };
}

// ---------------------------------------------------------------------------
// Cache primitives
// ---------------------------------------------------------------------------

async function readKvCache(env: Env): Promise<CachedListing | null> {
  const raw = await env.KV_KEY_CACHE.get(KV_CACHE_KEY, 'json').catch(() => null);
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.fetched_at !== 'number' || !Array.isArray(r.data)) return null;
  return { fetched_at: r.fetched_at, data: r.data as ZoneDomainStatus[] };
}

async function writeKvCache(env: Env, listing: CachedListing): Promise<void> {
  await env.KV_KEY_CACHE.put(KV_CACHE_KEY, JSON.stringify(listing), {
    expirationTtl: KV_CACHE_TTL_SECONDS,
  }).catch(() => {
    // KV is best-effort; on failure we still have the module cache.
  });
}

async function bustCaches(env: Env): Promise<void> {
  listCache = null;
  await env.KV_KEY_CACHE.delete(KV_CACHE_KEY).catch(() => undefined);
}

/**
 * Force-refresh the listing — live `inspectAllZones`, write to both
 * caches. Exposed so the hourly domain-verify cron can prime the cache
 * (services/api/src/scheduled/domain-verify.ts). Returns the count of
 * zones seen so the cron can include it in its telemetry line.
 */
export async function refreshCfZoneCache(env: Env): Promise<{ zones: number; skipped: boolean }> {
  const made = makeClient(env);
  if ('error' in made) return { zones: 0, skipped: true };
  const data = await inspectAllZones(made, makeInspectorEnv(env));
  const listing: CachedListing = { fetched_at: Date.now(), data };
  listCache = listing;
  await writeKvCache(env, listing);
  return { zones: data.length, skipped: false };
}

/**
 * Read-through listing fetch. Module cache → KV cache → live inspect.
 * `forceLive=true` (operators clicking refresh) bypasses both caches.
 */
async function getCfZoneListing(
  env: Env,
  client: CloudflareApiClient,
  forceLive: boolean,
): Promise<{ listing: CachedListing; from: 'module' | 'kv' | 'live' }> {
  const now = Date.now();
  if (!forceLive && listCache && now - listCache.fetched_at < MODULE_CACHE_TTL_MS) {
    return { listing: listCache, from: 'module' };
  }
  if (!forceLive) {
    const kv = await readKvCache(env);
    if (kv) {
      listCache = kv;
      return { listing: kv, from: 'kv' };
    }
  }
  const data = await inspectAllZones(client, makeInspectorEnv(env));
  const listing: CachedListing = { fetched_at: now, data };
  listCache = listing;
  await writeKvCache(env, listing);
  return { listing, from: 'live' };
}

// ---------- GET /v1/admin/cf-zones ----------
// Lists every zone in the operator's CF account with per-zone status.
// Read-through cache (module 60s → KV 90min → live). `?refresh=1` forces
// a live inspect.
cfZones.get('/v1/admin/cf-zones', requireScope('admin:read'), async (c) => {
  const made = makeClient(c.env);
  if ('error' in made) return made.error;
  const forceLive = c.req.query('refresh') === '1';
  const { listing, from } = await getCfZoneListing(c.env, made, forceLive);
  return c.json({
    data: listing.data,
    fetched_at: new Date(listing.fetched_at).toISOString(),
    cached: from !== 'live',
    source: from,
  });
});

// ---------- GET /v1/admin/cf-zones/:name ----------
// Returns the per-zone status from the cached listing. `?refresh=1`
// forces a fresh inspect (the legacy semantic for the panel's Refresh
// button). No extra `inspectZone` re-fetch on the cached path — the
// listing already carries every field the panel renders.
cfZones.get('/v1/admin/cf-zones/:name', requireScope('admin:read'), async (c) => {
  const made = makeClient(c.env);
  if ('error' in made) return made.error;
  const name = c.req.param('name');
  const forceLive = c.req.query('refresh') === '1';
  if (forceLive) {
    // The operator wants the freshest possible view of this single zone
    // (typically after hitting Apply). Refresh the listing then return
    // the matching row's re-inspected status.
    const refreshed = await refreshCfZoneCache(c.env);
    void refreshed;
    const found = listCache?.data.find((z) => z.zone.name === name);
    if (!found) return buildError(c, 'not_found', `no CF zone named ${name} in this account`);
    const fresh = await inspectZone(made, found.zone, makeInspectorEnv(c.env));
    return c.json({ data: fresh, cached: false, source: 'live' });
  }
  const { listing, from } = await getCfZoneListing(c.env, made, false);
  const found = listing.data.find((z) => z.zone.name === name);
  if (!found) return buildError(c, 'not_found', `no CF zone named ${name} in this account`);
  return c.json({
    data: found,
    fetched_at: new Date(listing.fetched_at).toISOString(),
    cached: from !== 'live',
    source: from,
  });
});

// ---------- POST /v1/admin/cf-zones/:name/configure ----------
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

  // Live inspect at configure time — the operator is about to mutate
  // state and we don't want to apply ops based on a stale cache.
  const all = await inspectAllZones(made, insp);
  const found = all.find((z) => z.zone.name === name);
  if (!found) return buildError(c, 'not_found', `no CF zone named ${name} in this account`);
  const status = await inspectZone(made, found.zone, insp);

  const fullDiff = computeDiff(status, { inboundWorkerName });
  const selectedOps = body.op_kinds
    ? fullDiff.ops.filter((op) => body.op_kinds!.includes(op.kind))
    : fullDiff.ops;
  const diff = { ...fullDiff, ops: selectedOps };

  if (dryRun) {
    return c.json({ dry_run: true, diff });
  }

  // Invalidate both caches before applying so the next GET reflects
  // post-apply state. The next cron run (or panel refresh) re-primes.
  await bustCaches(c.env);

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
export function _resetCfZoneListCache(): void {
  listCache = null;
}
