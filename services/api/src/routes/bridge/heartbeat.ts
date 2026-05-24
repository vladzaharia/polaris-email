// Bridge heartbeat ingest.
//
// The on-prem mail-bridge POSTs to /v1/bridge/heartbeat every ~60s with
// version + a small rolled-up snapshot of in-process counters. The body
// is HMAC-signed with the bridge's own per-bridge key (NOT an admin api
// key), so this endpoint sits outside the admin router and uses
// `bridgeHmacAuth()` directly — same auth surface as POST /v1/messages
// (RFC822 mode) and POST /v1/messages-state.
//
// Why a separate Hono sub-router instead of reusing the admin one:
//   * `admin.use('/v1/bridge/*', adminHmac)` covers credential-lookup
//     (admin api key with `imap_bridge:read`). The bridge has TWO
//     secrets: that admin api key (for cred lookup) and its own HMAC key
//     (for everything that needs per-bridge attribution). Heartbeat
//     belongs to the second bucket — otherwise a tenant with
//     `imap_bridge:read` could spoof another bridge's liveness.
//   * `admin.ts` bypasses /v1/bridge/heartbeat in its middleware so
//     control falls through to this sub-router.
//
// Storage:
//   * `bridges.last_heartbeat_json` — raw payload, opaque blob (we
//     re-parse with the Zod schema before returning on GET).
//   * `bridges.last_heartbeat_at` — server clock at receive time (guards
//     against bridge clock skew). The bridge's own `reported_at` lives
//     inside the payload.
//   * `bridges.bridge_version` — extracted from payload so list queries
//     can show it without parsing JSON per row.
//   * `bridges.last_seen_at` — bumped via `bridgeHmacAuth()` already, no
//     extra write here.
import { Hono } from 'hono';
import { BridgeHeartbeatBody } from '@polaris-mail/schema';
import { bridgeHmacAuth } from '../../bridge-auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const bridgeHeartbeat = new Hono<{ Bindings: Env }>();

bridgeHeartbeat.use('/v1/bridge/heartbeat', bridgeHmacAuth());

bridgeHeartbeat.post('/v1/bridge/heartbeat', async (c) => {
  const bridgeId = c.get('bridgeId');
  // `bridgeHmacAuth()` already drained the body for HMAC verification and
  // stashed it on the request as `_cachedBody`. Re-read from there so we
  // don't double-consume the stream.
  const cached = (c.req as unknown as { _cachedBody?: string })._cachedBody;
  const raw = cached ?? (await c.req.text());
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return buildError(c, 'bad_request', 'invalid json');
  }
  const result = BridgeHeartbeatBody.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    return buildError(
      c,
      'bad_request',
      first ? `${first.path.join('.')}: ${first.message}` : 'invalid heartbeat body',
    );
  }
  const body = result.data;
  const nowIso = new Date().toISOString();
  // Store the canonical re-serialised form so what we read back later
  // matches the schema exactly (the bridge could legally send extra
  // fields; Zod strips them on parse but the raw string would keep them).
  const canonical = JSON.stringify(body);
  const update = await c.env.DB.prepare(
    `UPDATE bridges
       SET last_heartbeat_at = ?,
           last_heartbeat_json = ?,
           bridge_version = ?,
           last_seen_at = ?
     WHERE id = ? AND disabled_at IS NULL`,
  )
    .bind(nowIso, canonical, body.bridge_version, nowIso, bridgeId)
    .run();
  if (update.meta.changes === 0) {
    // Either unknown id or disabled. `bridgeHmacAuth()` would normally
    // 401 these earlier, so reaching here means the row was disabled
    // between auth lookup and this UPDATE — treat as unauthorized.
    return buildError(c, 'unauthorized', 'bridge disabled');
  }
  return c.body(null, 204);
});
