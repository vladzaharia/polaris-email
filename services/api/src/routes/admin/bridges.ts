// Admin bridges routes. The `bridges` row records each registered
// mail-bridge instance + its HMAC key reference.
//
// Read-once secret discipline (A11 / B6):
//   * POST /v1/admin/bridges returns the plaintext HMAC key ONCE.
//   * POST /v1/admin/bridges/:id/rotate returns the new key ONCE.
//   * GET responses omit the stored hash column entirely.
import { Hono } from 'hono';
import { BridgeHeartbeatBody, type BridgeLiveness } from '@polaris-mail/schema';
import { actorOf, audit } from '../../audit.js';
import { bodyText, requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';
import { ulid } from '@polaris-mail/ids';
import { generateSecret } from '@polaris-mail/hmac';
import { hashSecret } from '../../hashing.js';
import { bridgePlainKvKey, BRIDGE_PLAIN_KV_TTL_SECONDS } from '../../bridge-auth.js';
import {
  bridgeCfDnsPlainKvKey,
  BRIDGE_CF_DNS_PLAIN_KV_TTL_SECONDS,
  mintCfDnsTokenForBridge,
  revokeCfDnsTokenBestEffort,
} from '../../bridge-cf-token.js';
import {
  bridgeTsAuthkeyPlainKvKey,
  BRIDGE_TS_AUTHKEY_PLAIN_KV_TTL_SECONDS,
  mintTsAuthKeyForBridge,
  revokeTsAuthKeyBestEffort,
} from '../../bridge-ts-token.js';
import { generateNonce } from '@polaris-mail/hmac';
import {
  bridgeInstallerKvKey,
  BRIDGE_INSTALLER_KV_TTL_SECONDS,
  type BridgeInstallerPayload,
} from '../installer/bridge.js';

// Liveness thresholds (ms). Anything inside `LIVE_MS` is "live"; inside
// `STALE_MS` is "stale" (concerning but not gone); beyond is "offline".
// 90s gives a 60s heartbeat interval one full skipped beat of slack
// before we start raising eyebrows.
const LIVE_MS = 90 * 1000;
const STALE_MS = 10 * 60 * 1000;

function livenessFromLastSeen(lastSeenAt: string | null, nowMs: number): BridgeLiveness {
  if (!lastSeenAt) return 'offline';
  const t = Date.parse(lastSeenAt);
  if (!Number.isFinite(t)) return 'offline';
  const ageMs = nowMs - t;
  if (ageMs <= LIVE_MS) return 'live';
  if (ageMs <= STALE_MS) return 'stale';
  return 'offline';
}

export const bridges = new Hono<{ Bindings: Env }>();

interface BridgeRow {
  id: string;
  name: string;
  hmac_key_secret_name: string | null;
  access_token_id: string | null;
  last_seen_at: string | null;
  created_at: string;
  disabled_at: string | null;
}

bridges.get('/v1/admin/bridges', requireScope('admin:read'), async (c) => {
  // Note: `hmac_key_secret_name` (the stored argon2id hash of the HMAC key)
  // is deliberately omitted from GET responses per A11. We do surface the
  // telemetry columns (last_heartbeat_at, bridge_version) so the list
  // page can render a liveness pill without a per-row follow-up fetch.
  // `serves_mailboxes` is global today (every bridge serves every active
  // mailbox via webhook fan-out) so it's the same value on every row —
  // computed once below and stamped onto each row for the panel to read.
  const rows = await c.env.DB.prepare(
    `SELECT id, name, access_token_id,
            last_seen_at, created_at, disabled_at,
            last_heartbeat_at, bridge_version
     FROM bridges ORDER BY name ASC`,
  ).all<
    Omit<BridgeRow, 'hmac_key_secret_name'> & {
      last_heartbeat_at: string | null;
      bridge_version: string | null;
    }
  >();
  const serves = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM mailboxes WHERE disabled_at IS NULL`,
  ).first<{ n: number }>();
  const servesMailboxes = serves?.n ?? 0;
  const nowMs = Date.now();
  const data = rows.results.map((r) => ({
    ...r,
    liveness: livenessFromLastSeen(r.last_seen_at, nowMs),
    serves_mailboxes: servesMailboxes,
  }));
  return c.json({ data });
});

bridges.post('/v1/admin/bridges', requireScope('admin:rotate'), async (c) => {
  let body: { name?: string; mode?: 'tailscale' | 'public' };
  try {
    body = JSON.parse(bodyText(c) || '{}') as { name?: string; mode?: 'tailscale' | 'public' };
  } catch {
    return buildError(c, 'bad_request', 'invalid json');
  }
  if (!body.name || typeof body.name !== 'string' || body.name.length < 1) {
    return buildError(c, 'bad_request', 'name required');
  }
  const mode: 'tailscale' | 'public' = body.mode === 'public' ? 'public' : 'tailscale';
  const id = ulid();
  const secret = generateSecret();
  const hashed = await hashSecret(secret, c.env.ARGON2_PEPPER);
  const nowIso = new Date().toISOString();
  // Mint optional integrations BEFORE the INSERT so a failed mint
  // leaves no orphan bridge row. Both CF and TS can be disabled by
  // omitting the relevant env vars — mint functions return `{id:
  // null}` and we proceed without that integration. Failures (env
  // present but call failed) bubble as 502 since the operator
  // presumably wants the integration when it's configured.
  let cfMinted;
  try {
    cfMinted = await mintCfDnsTokenForBridge(c.env, body.name, id);
  } catch (e) {
    return buildError(
      c,
      'degraded',
      `cf token mint failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let tsMinted;
  try {
    tsMinted = await mintTsAuthKeyForBridge(c.env, body.name);
  } catch (e) {
    // Roll back the CF token we just minted to avoid a half-provisioned
    // bridge that the operator can't reach.
    if (cfMinted.tokenId) await revokeCfDnsTokenBestEffort(c.env, cfMinted.tokenId);
    return buildError(
      c,
      'degraded',
      `ts auth-key mint failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  try {
    await c.env.DB.prepare(
      `INSERT INTO bridges
         (id, name, hmac_key_secret_name, cf_dns_token_id, ts_authkey_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, body.name, hashed, cfMinted.tokenId, tsMinted.key?.id ?? null, nowIso)
      .run();
  } catch (e) {
    // Best-effort revoke of both tokens so external state stays clean.
    if (cfMinted.tokenId) await revokeCfDnsTokenBestEffort(c.env, cfMinted.tokenId);
    if (tsMinted.key) await revokeTsAuthKeyBestEffort(c.env, tsMinted.key.id);
    if (String(e).includes('UNIQUE')) return buildError(c, 'conflict', 'bridge name taken');
    throw e;
  }
  // Cache plaintext for HMAC verify lookups. The stored hash is one-way; on
  // KV miss the bridge has to be rotated to repopulate (Phase 2h).
  await c.env.KV_KEY_CACHE.put(bridgePlainKvKey(id), secret, {
    expirationTtl: BRIDGE_PLAIN_KV_TTL_SECONDS,
  });
  if (cfMinted.plaintext) {
    // CF token plaintext — surfaced to the bridge via /v1/bridge/config.
    await c.env.KV_KEY_CACHE.put(bridgeCfDnsPlainKvKey(id), cfMinted.plaintext, {
      expirationTtl: BRIDGE_CF_DNS_PLAIN_KV_TTL_SECONDS,
    });
  }
  if (tsMinted.key) {
    // TS authkey plaintext — surfaced to the bridge via /v1/bridge/config.
    // The bridge's bootstrap-tailscale subcommand reads it and writes to
    // /run/secrets/ts_authkey so the TS sidecar can pick it up at compose
    // up. Operators never see this value.
    await c.env.KV_KEY_CACHE.put(bridgeTsAuthkeyPlainKvKey(id), tsMinted.key.value, {
      expirationTtl: BRIDGE_TS_AUTHKEY_PLAIN_KV_TTL_SECONDS,
    });
  }
  await audit(c.env, {
    actor: actorOf(c),
    action: 'bridge.register',
    target: id,
    meta: { name: body.name },
  });
  if (cfMinted.tokenId) {
    await audit(c.env, {
      actor: actorOf(c),
      action: 'bridge.cf_token.mint',
      target: id,
      meta: { token_id: cfMinted.tokenId, name: body.name },
    });
  }
  if (tsMinted.key) {
    await audit(c.env, {
      actor: actorOf(c),
      action: 'bridge.ts_authkey.mint',
      target: id,
      meta: { key_id: tsMinted.key.id, name: body.name },
    });
  }
  // One-shot installer token. The panel renders `curl
  // <api>/v1/installer/bridge/<token> | sh` and the operator pipes
  // it on the bridge host. KV TTL is 1h; the installer endpoint
  // deletes the entry after first GET.
  const installerToken = generateNonce();
  const installerPayload: BridgeInstallerPayload = {
    bridge_id: id,
    bridge_name: body.name,
    hmac_key: secret,
    mode,
    api_url: c.env.API_BASE_URL,
    image: 'ghcr.io/vladzaharia/polaris-mail-bridge:latest',
  };
  await c.env.KV_KEY_CACHE.put(
    bridgeInstallerKvKey(installerToken),
    JSON.stringify(installerPayload),
    { expirationTtl: BRIDGE_INSTALLER_KV_TTL_SECONDS },
  );

  return c.json(
    {
      id,
      name: body.name,
      hmac_key: secret,
      // One-shot bash-installer URL. Token is valid for 1h, consumed
      // on first GET. Operator runs:
      //   curl <api>/v1/installer/bridge/<token> | sh
      //
      // The TS auth key (when minted) is NOT in this response — it
      // flows directly from the api worker to the bridge over its own
      // HMAC channel via /v1/bridge/config, so operators never have
      // to write `ts_authkey` to disk themselves. A bootstrap init
      // container in the compose handles the fetch + file write at
      // `docker compose up` time.
      installer_token: installerToken,
      installer_url: `${c.env.API_BASE_URL}/v1/installer/bridge/${installerToken}`,
    },
    201,
  );
});

bridges.get('/v1/admin/bridges/lookup', requireScope('admin:read'), async (c) => {
  const name = c.req.query('name');
  if (!name) return buildError(c, 'bad_request', 'name required');
  // Hash column omitted from GET responses. Telemetry columns included
  // for parity with the by-id GET — same shape; same panel consumers.
  const row = await c.env.DB.prepare(
    `SELECT id, name, access_token_id,
            last_seen_at, created_at, disabled_at,
            last_heartbeat_at, bridge_version
     FROM bridges WHERE name = ?`,
  )
    .bind(name)
    .first<
      Omit<BridgeRow, 'hmac_key_secret_name'> & {
        last_heartbeat_at: string | null;
        bridge_version: string | null;
      }
    >();
  if (!row) return buildError(c, 'not_found', 'bridge not found');
  const serves = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM mailboxes WHERE disabled_at IS NULL`,
  ).first<{ n: number }>();
  return c.json({
    ...row,
    liveness: livenessFromLastSeen(row.last_seen_at, Date.now()),
    serves_mailboxes: serves?.n ?? 0,
  });
});

bridges.get('/v1/admin/bridges/:id', requireScope('admin:read'), async (c) => {
  const id = c.req.param('id');
  // Hash column omitted from GET responses. Telemetry columns included
  // so the detail page header can render without a follow-up fetch.
  const row = await c.env.DB.prepare(
    `SELECT id, name, access_token_id,
            last_seen_at, created_at, disabled_at,
            last_heartbeat_at, bridge_version
     FROM bridges WHERE id = ?`,
  )
    .bind(id)
    .first<
      Omit<BridgeRow, 'hmac_key_secret_name'> & {
        last_heartbeat_at: string | null;
        bridge_version: string | null;
      }
    >();
  if (!row) return buildError(c, 'not_found', 'bridge not found');
  const serves = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM mailboxes WHERE disabled_at IS NULL`,
  ).first<{ n: number }>();
  return c.json({
    ...row,
    liveness: livenessFromLastSeen(row.last_seen_at, Date.now()),
    serves_mailboxes: serves?.n ?? 0,
  });
});

bridges.post('/v1/admin/bridges/:id/rotate', requireScope('admin:rotate'), async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare(
    `SELECT id, name, cf_dns_token_id, ts_authkey_id FROM bridges WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: string;
      name: string;
      cf_dns_token_id: string | null;
      ts_authkey_id: string | null;
    }>();
  if (!existing) return buildError(c, 'not_found', 'bridge not found');
  const secret = generateSecret();
  const hashed = await hashSecret(secret, c.env.ARGON2_PEPPER);
  // Same atomicity discipline as register: mint both upstream tokens
  // BEFORE touching D1. CF/TS individually optional — null returns
  // mean "not configured", we proceed without that integration.
  let cfMinted;
  try {
    cfMinted = await mintCfDnsTokenForBridge(c.env, existing.name, id);
  } catch (e) {
    return buildError(
      c,
      'degraded',
      `cf token mint failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let tsMinted;
  try {
    tsMinted = await mintTsAuthKeyForBridge(c.env, existing.name);
  } catch (e) {
    if (cfMinted.tokenId) await revokeCfDnsTokenBestEffort(c.env, cfMinted.tokenId);
    return buildError(
      c,
      'degraded',
      `ts auth-key mint failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  await c.env.DB.prepare(
    `UPDATE bridges
       SET hmac_key_secret_name = ?, cf_dns_token_id = ?, ts_authkey_id = ?
     WHERE id = ?`,
  )
    .bind(hashed, cfMinted.tokenId, tsMinted.key?.id ?? null, id)
    .run();
  // Repopulate plaintext caches so verify + /v1/bridge/config both
  // resolve immediately after rotate.
  await c.env.KV_KEY_CACHE.put(bridgePlainKvKey(id), secret, {
    expirationTtl: BRIDGE_PLAIN_KV_TTL_SECONDS,
  });
  if (cfMinted.plaintext) {
    await c.env.KV_KEY_CACHE.put(bridgeCfDnsPlainKvKey(id), cfMinted.plaintext, {
      expirationTtl: BRIDGE_CF_DNS_PLAIN_KV_TTL_SECONDS,
    });
  } else {
    await c.env.KV_KEY_CACHE.delete(bridgeCfDnsPlainKvKey(id));
  }
  if (tsMinted.key) {
    await c.env.KV_KEY_CACHE.put(bridgeTsAuthkeyPlainKvKey(id), tsMinted.key.value, {
      expirationTtl: BRIDGE_TS_AUTHKEY_PLAIN_KV_TTL_SECONDS,
    });
  } else {
    await c.env.KV_KEY_CACHE.delete(bridgeTsAuthkeyPlainKvKey(id));
  }
  // Best-effort revokes of the prior tokens.
  if (existing.cf_dns_token_id) {
    c.executionCtx.waitUntil(revokeCfDnsTokenBestEffort(c.env, existing.cf_dns_token_id));
    await audit(c.env, {
      actor: actorOf(c),
      action: 'bridge.cf_token.revoke',
      target: id,
      meta: { token_id: existing.cf_dns_token_id, reason: 'rotate' },
    });
  }
  if (existing.ts_authkey_id) {
    c.executionCtx.waitUntil(revokeTsAuthKeyBestEffort(c.env, existing.ts_authkey_id));
    await audit(c.env, {
      actor: actorOf(c),
      action: 'bridge.ts_authkey.revoke',
      target: id,
      meta: { key_id: existing.ts_authkey_id, reason: 'rotate' },
    });
  }
  await audit(c.env, {
    actor: actorOf(c),
    action: 'bridge.rotate',
    target: id,
    meta: { name: existing.name },
  });
  if (cfMinted.tokenId) {
    await audit(c.env, {
      actor: actorOf(c),
      action: 'bridge.cf_token.mint',
      target: id,
      meta: { token_id: cfMinted.tokenId, name: existing.name, reason: 'rotate' },
    });
  }
  if (tsMinted.key) {
    await audit(c.env, {
      actor: actorOf(c),
      action: 'bridge.ts_authkey.mint',
      target: id,
      meta: { key_id: tsMinted.key.id, name: existing.name, reason: 'rotate' },
    });
  }
  // Rotate also refreshes the installer URL so the operator can
  // re-run the bash installer on the bridge host. Mode is inferred
  // from whether TS was minted — best signal we have without a
  // schema-side mode column.
  const installerToken = generateNonce();
  const rotateMode: 'tailscale' | 'public' = tsMinted.key != null ? 'tailscale' : 'public';
  const installerPayload: BridgeInstallerPayload = {
    bridge_id: id,
    bridge_name: existing.name,
    hmac_key: secret,
    mode: rotateMode,
    api_url: c.env.API_BASE_URL,
    image: 'ghcr.io/vladzaharia/polaris-mail-bridge:latest',
  };
  await c.env.KV_KEY_CACHE.put(
    bridgeInstallerKvKey(installerToken),
    JSON.stringify(installerPayload),
    { expirationTtl: BRIDGE_INSTALLER_KV_TTL_SECONDS },
  );

  return c.json({
    id,
    hmac_key: secret,
    installer_token: installerToken,
    installer_url: `${c.env.API_BASE_URL}/v1/installer/bridge/${installerToken}`,
  });
});

// DELETE has two modes:
//   * Default (soft) — sets `disabled_at`. The row stays for audit /
//     message-attribution purposes; the HMAC key is rejected on
//     subsequent requests.
//   * `?hard=true`   — physically removes the row. Requires the bridge
//     to already be deregistered (soft-disabled). Any messages still
//     attributed to the bridge get `bridge_id = NULL` so historical
//     activity is preserved without the FK reference. Submission
//     credentials with a stale `bridge_id` get the same NULL
//     treatment. Audit_log rows that name the bridge as `target` stay
//     forever — that table is append-only by design.
bridges.delete('/v1/admin/bridges/:id', requireScope('admin:rotate'), async (c) => {
  const id = c.req.param('id');
  const hard = c.req.query('hard') === 'true';

  if (!hard) {
    const nowIso = new Date().toISOString();
    const r = await c.env.DB.prepare(
      `UPDATE bridges SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL`,
    )
      .bind(nowIso, id)
      .run();
    if (r.meta.changes === 0) return buildError(c, 'not_found', 'not found or already disabled');
    // Drop the plaintext cache so any further verify with this id 401s
    // immediately rather than waiting on the TTL.
    await c.env.KV_KEY_CACHE.delete(bridgePlainKvKey(id));
    await audit(c.env, {
      actor: actorOf(c),
      action: 'bridge.deregister',
      target: id,
      meta: {},
    });
    return c.json({ id, disabled_at: Date.now() });
  }

  // Hard delete path.
  const existing = await c.env.DB.prepare(
    `SELECT id, name, disabled_at, cf_dns_token_id, ts_authkey_id FROM bridges WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: string;
      name: string;
      disabled_at: string | null;
      cf_dns_token_id: string | null;
      ts_authkey_id: string | null;
    }>();
  if (!existing) return buildError(c, 'not_found', 'bridge not found');
  if (existing.disabled_at == null) {
    return buildError(
      c,
      'conflict',
      'bridge must be deregistered before it can be permanently deleted',
    );
  }

  // D1 batches run under one implicit transaction, so the NULL-out +
  // DELETE on the FK-bearing column commit together. `messages.bridge_id`
  // is the only live FK to bridges; `submission_credentials` was dropped
  // in migration 0003.
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE messages SET bridge_id = NULL WHERE bridge_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM bridges WHERE id = ?`).bind(id),
  ]);

  await c.env.KV_KEY_CACHE.delete(bridgePlainKvKey(id));
  await c.env.KV_KEY_CACHE.delete(bridgeCfDnsPlainKvKey(id));
  await c.env.KV_KEY_CACHE.delete(bridgeTsAuthkeyPlainKvKey(id));
  // Best-effort CF cleanup. Orphan tokens cost nothing operationally
  // but they clutter the dashboard; we want the audit-log entry on
  // success so a future "list orphans" cron has something to compare.
  if (existing.cf_dns_token_id) {
    c.executionCtx.waitUntil(revokeCfDnsTokenBestEffort(c.env, existing.cf_dns_token_id));
    await audit(c.env, {
      actor: actorOf(c),
      action: 'bridge.cf_token.revoke',
      target: id,
      meta: { token_id: existing.cf_dns_token_id, reason: 'delete' },
    });
  }
  if (existing.ts_authkey_id) {
    c.executionCtx.waitUntil(revokeTsAuthKeyBestEffort(c.env, existing.ts_authkey_id));
    await audit(c.env, {
      actor: actorOf(c),
      action: 'bridge.ts_authkey.revoke',
      target: id,
      meta: { key_id: existing.ts_authkey_id, reason: 'delete' },
    });
  }
  await audit(c.env, {
    actor: actorOf(c),
    action: 'bridge.delete',
    target: id,
    meta: { name: existing.name },
  });
  return c.json({ id, deleted: true });
});

// ---------- per-bridge telemetry endpoints ----------
//
// All three are admin:read. They surface what the new panel detail page
// needs without forcing the panel to assemble it from generic endpoints.

// Latest heartbeat snapshot. `payload` is the parsed BridgeHeartbeatBody
// (or null if the bridge has never phoned home). Server-side `liveness`
// is computed from `last_seen_at`, NOT from `last_heartbeat_at` — a
// bridge that's submitting messages but hasn't sent a heartbeat yet
// (older binary, partition during boot) should still read as `live`.
bridges.get('/v1/admin/bridges/:id/heartbeat', requireScope('admin:read'), async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT id, last_seen_at, last_heartbeat_at, last_heartbeat_json, bridge_version
       FROM bridges WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: string;
      last_seen_at: string | null;
      last_heartbeat_at: string | null;
      last_heartbeat_json: string | null;
      bridge_version: string | null;
    }>();
  if (!row) return buildError(c, 'not_found', 'bridge not found');
  let payload: unknown = null;
  if (row.last_heartbeat_json) {
    try {
      const parsed = BridgeHeartbeatBody.safeParse(JSON.parse(row.last_heartbeat_json));
      // If the stored payload no longer parses (schema bumped, manual
      // tampering), surface null rather than half-parsed garbage. The
      // raw bytes stay on disk; just don't show them to the panel.
      if (parsed.success) payload = parsed.data;
    } catch {
      payload = null;
    }
  }
  return c.json({
    bridge_id: row.id,
    liveness: livenessFromLastSeen(row.last_seen_at, Date.now()),
    last_seen_at: row.last_seen_at,
    last_heartbeat_at: row.last_heartbeat_at,
    bridge_version: row.bridge_version,
    payload,
  });
});

// 24h message activity rollup keyed by `messages.bridge_id`. The
// covering index added in migration 0007 (`idx_messages_bridge_created`)
// keeps this index-driven. Status buckets follow the same vocabulary
// the panel already uses for mailbox rollups (sent/delivered/failed/
// bounced/inflight) — the panel can render either page with the same
// component if we ever want to.
bridges.get('/v1/admin/bridges/:id/activity', requireScope('admin:read'), async (c) => {
  const id = c.req.param('id');
  const exists = await c.env.DB.prepare(`SELECT 1 FROM bridges WHERE id = ?`)
    .bind(id)
    .first<{ 1: number }>();
  if (!exists) return buildError(c, 'not_found', 'bridge not found');
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const totalsRow = await c.env.DB.prepare(
    `SELECT
       COUNT(*)                                                       AS submitted,
       SUM(CASE WHEN status IN ('delivered','sent')           THEN 1 ELSE 0 END) AS delivered,
       SUM(CASE WHEN status IN ('failed','rejected')          THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'bounced'                       THEN 1 ELSE 0 END) AS bounced,
       SUM(CASE WHEN status IN ('queued','sending','pending') THEN 1 ELSE 0 END) AS inflight
     FROM messages
     WHERE bridge_id = ? AND created_at >= ?`,
  )
    .bind(id, since)
    .first<{
      submitted: number | null;
      delivered: number | null;
      failed: number | null;
      bounced: number | null;
      inflight: number | null;
    }>();
  const latest = await c.env.DB.prepare(
    `SELECT id, subject, status, created_at
       FROM messages
       WHERE bridge_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
  )
    .bind(id)
    .first<{ id: string; subject: string | null; status: string; created_at: string }>();
  return c.json({
    bridge_id: id,
    window: '24h' as const,
    totals: {
      submitted: totalsRow?.submitted ?? 0,
      delivered: totalsRow?.delivered ?? 0,
      failed: totalsRow?.failed ?? 0,
      bounced: totalsRow?.bounced ?? 0,
      inflight: totalsRow?.inflight ?? 0,
    },
    latest_message: latest ?? null,
  });
});

// Bridge-scoped audit feed. Same shape as the domain-scoped feed in
// `domains.ts:443+`. Three audit actions already write `target: id`
// from this same file (register, rotate, deregister) so no extra work
// is needed in the mutation handlers above.
bridges.get('/v1/admin/bridges/:id/audit', requireScope('admin:read'), async (c) => {
  const id = c.req.param('id');
  const limitRaw = Number.parseInt(c.req.query('limit') ?? '25', 10);
  const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 25));
  const beforeId = Number.parseInt(c.req.query('before_id') ?? '0', 10);
  let rows;
  if (beforeId > 0) {
    rows = await c.env.DB.prepare(
      `SELECT id, actor, action, target, at, prev_hash, row_hash, meta
         FROM audit_log
        WHERE target = ? AND id < ?
        ORDER BY id DESC LIMIT ?`,
    )
      .bind(id, beforeId, limit)
      .all();
  } else {
    rows = await c.env.DB.prepare(
      `SELECT id, actor, action, target, at, prev_hash, row_hash, meta
         FROM audit_log
        WHERE target = ?
        ORDER BY id DESC LIMIT ?`,
    )
      .bind(id, limit)
      .all();
  }
  return c.json({ data: rows.results });
});
