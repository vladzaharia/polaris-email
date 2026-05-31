// Bridge heartbeat v2 — bidirectional control + diagnostics.
//
// The on-prem mail-bridge POSTs to /v1/bridge/heartbeat every 60s
// (adaptive down to 5s during active ops). The request carries
// telemetry, log delta, settings_version, and acks for directives
// delivered in earlier heartbeats. The response carries enable/disable
// signal, the current `BridgeSettings` (only when bridge's stored
// version trails), pending directives (roll_hmac / restart), and a
// `next_heartbeat_in_seconds` hint.
//
// Auth: `bridgeHmacAuth({ allowDisabled, requireSubmissionId: false })`.
// Disabled bridges still authenticate against this path so the response
// can deliver `enabled: false` — the bridge's listener supervisor reads
// that signal and suspends SMTPS / IMAP without operator host-side
// action. Every other bridge-facing endpoint stays gated by the
// default `allowDisabled: false`.
//
// Storage on the api side:
//   * `bridges.last_heartbeat_at` — server clock at receive time.
//   * `bridges.last_heartbeat_json` — canonical re-serialised v2 payload
//     (the snapshot endpoint reads this back).
//   * `bridges.bridge_version` — extracted for list-page rendering.
//   * `bridges.last_seen_at` — bumped by `bridgeHmacAuth()`.
//   * R2 `bridge-logs/<id>/<yyyy-mm-dd>/<heartbeat-iso>.jsonl` —
//     logs delta from each heartbeat, one object per request.
//   * `bridge_directives.{delivered_at,acked_at}` — directive lifecycle.

import { Hono } from 'hono';
import {
  BridgeHeartbeatRequest,
  type BridgeHeartbeatResponse,
  type BridgeDirective,
  type BridgeSettings,
} from '@polaris-mail/schema';
import {
  bridgeHmacAuth,
  bridgePlainKvKey,
  bridgePlainNextKvKey,
  BRIDGE_PLAIN_KV_TTL_SECONDS,
} from '../../bridge-auth.js';
import { audit } from '../../audit.js';
import { hashSecret } from '../../hashing.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const bridgeHeartbeat = new Hono<{ Bindings: Env }>();

// Heartbeat is the only bridge endpoint that allows disabled bridges
// through auth — the response's `enabled: false` is the disable signal
// the bridge listens for. No submission id required either; this isn't
// a message-submission path.
bridgeHeartbeat.use(
  '/v1/bridge/heartbeat',
  bridgeHmacAuth({ allowDisabled: true, requireSubmissionId: false }),
);

interface BridgeSettingsRow {
  bridge_id: string;
  version: number;
  smtps_enabled: number;
  smtps_port: number;
  smtp_enabled: number;
  smtp_port: number;
  imaps_enabled: number;
  imaps_port: number;
  imap_enabled: number;
  imap_port: number;
  tls_source: 'auto' | 'manual';
  max_message_size_bytes: number;
  max_imap_sessions: number;
  log_level: 'debug' | 'info' | 'warn' | 'error';
  webhook_enabled: number;
  webhook_url_override: string | null;
}

function settingsRowToPayload(row: BridgeSettingsRow): BridgeSettings {
  return {
    version: row.version,
    smtps_enabled: row.smtps_enabled === 1,
    smtps_port: row.smtps_port,
    smtp_enabled: row.smtp_enabled === 1,
    smtp_port: row.smtp_port,
    imaps_enabled: row.imaps_enabled === 1,
    imaps_port: row.imaps_port,
    imap_enabled: row.imap_enabled === 1,
    imap_port: row.imap_port,
    tls_source: row.tls_source,
    max_message_size_bytes: row.max_message_size_bytes,
    max_imap_sessions: row.max_imap_sessions,
    log_level: row.log_level,
    webhook_enabled: row.webhook_enabled === 1,
    webhook_url_override: row.webhook_url_override,
  };
}

interface PendingDirectiveRow {
  id: string;
  bridge_id: string;
  kind: 'roll_hmac' | 'restart';
  payload: string;
  expires_at: string | null;
  delivered_at: string | null;
}

function directiveRowToPayload(row: PendingDirectiveRow): BridgeDirective | null {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    return null;
  }
  if (row.kind === 'roll_hmac') {
    const newKey = payload.new_hmac_key;
    const graceExpiresAt = payload.grace_expires_at;
    if (typeof newKey !== 'string' || typeof graceExpiresAt !== 'string') return null;
    return {
      id: row.id,
      kind: 'roll_hmac',
      new_hmac_key: newKey,
      grace_expires_at: graceExpiresAt,
    };
  }
  if (row.kind === 'restart') {
    const queuedAt = payload.queued_at;
    if (typeof queuedAt !== 'string') return null;
    return { id: row.id, kind: 'restart', queued_at: queuedAt };
  }
  return null;
}

bridgeHeartbeat.post('/v1/bridge/heartbeat', async (c) => {
  const bridgeId = c.get('bridgeId');
  const cached = (c.req as unknown as { _cachedBody?: string })._cachedBody;
  const raw = cached ?? (await c.req.text());
  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(raw);
  } catch {
    return buildError(c, 'bad_request', 'invalid json');
  }
  // Hard-reject v1 bridges with a clear "upgrade your image" signal so
  // operators don't bury themselves in 400s diagnosing parse failures.
  if (
    parsedRaw &&
    typeof parsedRaw === 'object' &&
    (parsedRaw as { schema_version?: unknown }).schema_version === 1
  ) {
    return buildError(c, 'bad_request', 'bridge image too old; upgrade to v2-compatible build');
  }
  const result = BridgeHeartbeatRequest.safeParse(parsedRaw);
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
  const canonical = JSON.stringify(body);

  // Confirm the bridge row still exists (no race between auth lookup
  // and now). `disabled_at` IS allowed here — we deliver the signal in
  // the response. Read it explicitly so we can set `enabled` correctly.
  const bridgeRow = await c.env.DB.prepare(
    `SELECT id, disabled_at, hmac_pending_rotated_at FROM bridges WHERE id = ?`,
  )
    .bind(bridgeId)
    .first<{
      id: string;
      disabled_at: string | null;
      hmac_pending_rotated_at: string | null;
    }>();
  if (!bridgeRow) return buildError(c, 'unauthorized', 'bridge unknown');

  // Diagnostics UPSERT — store the payload + bump telemetry columns.
  await c.env.DB.prepare(
    `UPDATE bridges
       SET last_heartbeat_at = ?,
           last_heartbeat_json = ?,
           bridge_version = ?,
           last_seen_at = ?
     WHERE id = ?`,
  )
    .bind(nowIso, canonical, body.bridge_version, nowIso, bridgeId)
    .run();

  // --- Log forwarding ---------------------------------------------------------
  // Append the request's logs delta to a fresh R2 object. One object per
  // heartbeat — easy to read back in order via the admin logs endpoint
  // (which sorts by key) without any per-bridge sequence tracking on
  // the server side.
  let logHighWater = body.last_log_seq;
  if (body.logs.length > 0) {
    const filtered = body.logs.filter((l) => l.seq > body.last_log_seq);
    if (filtered.length > 0) {
      const newest = filtered[filtered.length - 1]?.seq ?? logHighWater;
      logHighWater = newest;
      const date = nowIso.slice(0, 10); // YYYY-MM-DD
      const key = `bridge-logs/${bridgeId}/${date}/${nowIso}.jsonl`;
      const jsonl = filtered.map((l) => JSON.stringify(l)).join('\n');
      try {
        await c.env.R2.put(key, jsonl, {
          httpMetadata: { contentType: 'application/x-ndjson' },
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`heartbeat: r2 log put failed for ${bridgeId}: ${String(e)}`);
      }
    }
  }

  // --- Directive acks ---------------------------------------------------------
  // For each ack: look up directive, apply server-side effect (roll_hmac
  // ack promotes bridge_plain_next), mark acked, audit. We do this
  // before reading the pending-directive list so an ack that just
  // landed isn't echoed back to the bridge.
  for (const ack of body.directive_acks) {
    const dir = await c.env.DB.prepare(
      `SELECT id, bridge_id, kind, payload, acked_at FROM bridge_directives WHERE id = ?`,
    )
      .bind(ack.id)
      .first<{
        id: string;
        bridge_id: string;
        kind: string;
        payload: string;
        acked_at: string | null;
      }>();
    if (!dir || dir.bridge_id !== bridgeId) continue;
    if (dir.acked_at) continue; // idempotent
    if (dir.kind === 'roll_hmac') {
      let payload: { new_hmac_key?: unknown };
      try {
        payload = JSON.parse(dir.payload) as { new_hmac_key?: unknown };
      } catch {
        continue;
      }
      const newSecret = payload.new_hmac_key;
      if (typeof newSecret !== 'string' || newSecret.length === 0) continue;
      const newHash = await hashSecret(newSecret, c.env.ARGON2_PEPPER);
      await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE bridges
             SET hmac_key_secret_name = ?,
                 hmac_rotated_at = ?,
                 hmac_pending_rotated_at = NULL
           WHERE id = ?`,
        ).bind(newHash, nowIso, bridgeId),
        c.env.DB.prepare(`UPDATE bridge_directives SET acked_at = ? WHERE id = ?`).bind(
          ack.applied_at || nowIso,
          dir.id,
        ),
      ]);
      // Promote the staged plaintext: KV-move next → current, delete next.
      await c.env.KV_KEY_CACHE.put(bridgePlainKvKey(bridgeId), newSecret, {
        expirationTtl: BRIDGE_PLAIN_KV_TTL_SECONDS,
      });
      await c.env.KV_KEY_CACHE.delete(bridgePlainNextKvKey(bridgeId));
    } else if (dir.kind === 'restart') {
      await c.env.DB.prepare(`UPDATE bridge_directives SET acked_at = ? WHERE id = ?`)
        .bind(ack.applied_at || nowIso, dir.id)
        .run();
    }
    await audit(c.env, {
      actor: `bridge:${bridgeId}`,
      action: 'bridge.directive.ack',
      target: bridgeId,
      meta: { directive_id: dir.id, kind: dir.kind, applied_at: ack.applied_at },
    });
  }

  // --- Settings -------------------------------------------------------------
  // Read the stored settings row; include in response only when the
  // bridge's version trails. The default row is inserted on register,
  // so it always exists.
  const settingsRow = await c.env.DB.prepare(`SELECT * FROM bridge_settings WHERE bridge_id = ?`)
    .bind(bridgeId)
    .first<BridgeSettingsRow>();
  const settingsPayload: BridgeSettings | null =
    settingsRow && settingsRow.version > body.settings_version
      ? settingsRowToPayload(settingsRow)
      : null;

  // --- Pending directives ---------------------------------------------------
  const pendingRows = await c.env.DB.prepare(
    `SELECT id, bridge_id, kind, payload, expires_at, delivered_at
       FROM bridge_directives
      WHERE bridge_id = ? AND acked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY queued_at ASC`,
  )
    .bind(bridgeId, nowIso)
    .all<PendingDirectiveRow>();
  const directives: BridgeDirective[] = [];
  const toMarkDelivered: string[] = [];
  for (const r of pendingRows.results) {
    const d = directiveRowToPayload(r);
    if (!d) continue;
    directives.push(d);
    if (!r.delivered_at) toMarkDelivered.push(r.id);
  }
  if (toMarkDelivered.length > 0) {
    const placeholders = toMarkDelivered.map(() => '?').join(',');
    await c.env.DB.prepare(
      `UPDATE bridge_directives SET delivered_at = ?
         WHERE delivered_at IS NULL AND id IN (${placeholders})`,
    )
      .bind(nowIso, ...toMarkDelivered)
      .run();
  }

  const responseBody: BridgeHeartbeatResponse = {
    enabled: bridgeRow.disabled_at == null,
    reason: bridgeRow.disabled_at == null ? null : 'disabled_by_admin',
    // Faster polling when a directive is in flight; bridge picks up
    // the ack effect on the next tick. 60s otherwise.
    next_heartbeat_in_seconds: directives.length > 0 || settingsPayload ? 5 : 60,
    settings: settingsPayload,
    directives,
    log_high_water: logHighWater,
  };
  return c.json(responseBody);
});
