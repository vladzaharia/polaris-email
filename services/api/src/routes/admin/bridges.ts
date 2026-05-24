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
  let body: { name?: string };
  try {
    body = JSON.parse(bodyText(c) || '{}') as { name?: string };
  } catch {
    return buildError(c, 'bad_request', 'invalid json');
  }
  if (!body.name || typeof body.name !== 'string' || body.name.length < 1) {
    return buildError(c, 'bad_request', 'name required');
  }
  const id = ulid();
  const secret = generateSecret();
  const hashed = await hashSecret(secret, c.env.ARGON2_PEPPER);
  const nowIso = new Date().toISOString();
  try {
    await c.env.DB.prepare(
      `INSERT INTO bridges (id, name, hmac_key_secret_name, created_at)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(id, body.name, hashed, nowIso)
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return buildError(c, 'conflict', 'bridge name taken');
    throw e;
  }
  // Cache plaintext for HMAC verify lookups. The stored hash is one-way; on
  // KV miss the bridge has to be rotated to repopulate (Phase 2h).
  await c.env.KV_KEY_CACHE.put(bridgePlainKvKey(id), secret, {
    expirationTtl: BRIDGE_PLAIN_KV_TTL_SECONDS,
  });
  await audit(c.env, {
    actor: actorOf(c),
    action: 'bridge.register',
    target: id,
    meta: { name: body.name },
  });
  return c.json({ id, name: body.name, hmac_key: secret }, 201);
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
  const existing = await c.env.DB.prepare(`SELECT id, name FROM bridges WHERE id = ?`)
    .bind(id)
    .first<{ id: string; name: string }>();
  if (!existing) return buildError(c, 'not_found', 'bridge not found');
  const secret = generateSecret();
  const hashed = await hashSecret(secret, c.env.ARGON2_PEPPER);
  await c.env.DB.prepare(`UPDATE bridges SET hmac_key_secret_name = ? WHERE id = ?`)
    .bind(hashed, id)
    .run();
  // Repopulate the plaintext cache so verify lookups resolve immediately
  // after rotate (Phase 2h).
  await c.env.KV_KEY_CACHE.put(bridgePlainKvKey(id), secret, {
    expirationTtl: BRIDGE_PLAIN_KV_TTL_SECONDS,
  });
  await audit(c.env, {
    actor: actorOf(c),
    action: 'bridge.rotate',
    target: id,
    meta: { name: existing.name },
  });
  return c.json({ id, hmac_key: secret });
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
  const existing = await c.env.DB.prepare(`SELECT id, name, disabled_at FROM bridges WHERE id = ?`)
    .bind(id)
    .first<{ id: string; name: string; disabled_at: string | null }>();
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
