// Admin bridges routes. The `bridges` row records each registered
// mail-bridge instance + its HMAC key reference.
//
// Read-once secret discipline (A11 / B6):
//   * POST /v1/admin/bridges returns the plaintext HMAC key ONCE.
//   * POST /v1/admin/bridges/:id/rotate returns the new key ONCE.
//   * GET responses omit the stored hash column entirely.
import { Hono } from 'hono';
import { BridgeHeartbeatRequest, type BridgeLiveness } from '@polaris-mail/schema';
import { actorOf, audit } from '../../audit.js';
import { bodyText, requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';
import { ulid } from '@polaris-mail/ids';
import { generateSecret } from '@polaris-mail/hmac';
import { hashSecret } from '../../hashing.js';
import { bridgePlainKvKey, bridgePlainNextKvKey, FLOOR_S } from '../../bridge-auth.js';
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

/**
 * Build the install URL for `(bridgeId, hmacPlaintext)`. The URL itself
 * carries the HMAC, so possessing a working URL is equivalent to
 * possessing the bridge's current credential — there is no KV layer to
 * "fetch the install bundle"; the installer endpoint verifies the HMAC
 * against the stored hash and renders the script from the bridge row.
 *
 * Prefers `BRIDGE_INSTALLER_BASE_URL` (e.g. `https://dl.mail.plrs.im`)
 * for the short form; falls back to the canonical long form on the api
 * hostname when the var is unset.
 */
function installerUrlFor(env: Env, bridgeId: string, hmac: string): string {
  const base = env.BRIDGE_INSTALLER_BASE_URL;
  if (base) return `${base.replace(/\/$/, '')}/bridge/${bridgeId}/${hmac}`;
  return `${env.API_BASE_URL}/v1/installer/bridge/${bridgeId}/${hmac}`;
}

// How long a freshly-issued install URL stays live. The installer route
// 404s past this deadline; the first successful heartbeat closes it even
// sooner (see routes/bridge/heartbeat.ts). 8h — matches the plaintext
// cache floor, so a bridge that never phones home loses its leaky
// download link on the same clock the api would forget its key.
const INSTALLER_WINDOW_MS = 8 * 60 * 60 * 1000;

/** ISO timestamp `INSTALLER_WINDOW_MS` after `nowIso`. */
function installerWindowExpiry(nowIso: string): string {
  return new Date(Date.parse(nowIso) + INSTALLER_WINDOW_MS).toISOString();
}

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
  let tsMinted: Awaited<ReturnType<typeof mintTsAuthKeyForBridge>>;
  try {
    // Public-mode registrations skip TS key minting — the installer
    // route uses `ts_authkey_id IS NULL` to render the no-Tailscale
    // compose. Operators can change their mind later via rotate.
    tsMinted =
      mode === 'tailscale' ? await mintTsAuthKeyForBridge(c.env, body.name) : { key: null };
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
    // Two-statement batch: bridges row + default bridge_settings row.
    // D1 batches as one implicit transaction so a failure on either
    // leaves nothing behind.
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO bridges
           (id, name, hmac_key_secret_name, cf_dns_token_id, ts_authkey_id,
            created_at, hmac_rotated_at, installer_window_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        body.name,
        hashed,
        cfMinted.tokenId,
        tsMinted.key?.id ?? null,
        nowIso,
        nowIso,
        installerWindowExpiry(nowIso),
      ),
      c.env.DB.prepare(
        `INSERT INTO bridge_settings (bridge_id, updated_at, updated_by)
         VALUES (?, ?, ?)`,
      ).bind(id, nowIso, actorOf(c)),
    ]);
  } catch (e) {
    // Best-effort revoke of both tokens so external state stays clean.
    if (cfMinted.tokenId) await revokeCfDnsTokenBestEffort(c.env, cfMinted.tokenId);
    if (tsMinted.key) await revokeTsAuthKeyBestEffort(c.env, tsMinted.key.id);
    if (String(e).includes('UNIQUE')) return buildError(c, 'conflict', 'bridge name taken');
    throw e;
  }
  // Cache plaintext for HMAC verify lookups. The stored hash is one-way; on
  // KV miss the bridge has to be rotated to repopulate (Phase 2h). Seed at
  // the floor — heartbeats ramp the TTL up as the bridge earns tenure.
  await c.env.KV_KEY_CACHE.put(bridgePlainKvKey(id), secret, {
    expirationTtl: FLOOR_S,
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
  // The install URL is just `<base>/bridge/<id>/<hmac>` — the URL
  // itself carries the HMAC, so possessing it is equivalent to
  // possessing the current credential. Rotating the HMAC immediately
  // invalidates every URL ever minted with the old one; this is the
  // only time an operator gets a working URL.
  //
  // TS auth key (when minted) is NOT in this response — it flows
  // server-to-bridge over the HMAC channel via /v1/bridge/config, so
  // operators never write `ts_authkey` to disk themselves.
  return c.json(
    {
      id,
      name: body.name,
      hmac_key: secret,
      installer_url: installerUrlFor(c.env, id, secret),
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

/**
 * Resolve the grace window in seconds for a staged roll. Manual rolls
 * accept 10m / 1h / 24h / "until-acked" (Number.MAX_SAFE_INTEGER, KV-
 * limited); auto-roll passes "3600" verbatim.
 */
function parseGraceSeconds(raw: string | undefined): number {
  if (!raw) return 60 * 60; // default 1h
  if (raw === 'until-acked') return 30 * 24 * 60 * 60; // KV's max TTL is 60d; 30d is plenty
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 60 || n > 30 * 24 * 60 * 60) return 60 * 60;
  return n;
}

bridges.post('/v1/admin/bridges/:id/rotate', requireScope('admin:rotate'), async (c) => {
  const id = c.req.param('id');
  // mode=staged (default) — Heartbeat-delivered HMAC roll with a grace
  //   window during which both old and new HMACs are valid. Server
  //   queues a roll_hmac directive; bridge applies + acks on next
  //   heartbeat. CF DNS + TS tokens get rotated immediately (the bridge
  //   picks them up on next /v1/bridge/config fetch or restart). Needs a
  //   live bridge to ack — rejected for a disabled/deregistered node.
  // mode=now — Immediate HMAC swap, no grace window. The old key stops
  //   verifying at once; the operator reinstalls via the fresh install
  //   URL. The enable state is left untouched (an enabled bridge stays
  //   enabled; a disabled one stays disabled). This is the right roll
  //   for a disabled/deregistered node, where a grace window buys
  //   nothing (no live bridge to deliver the staged key to).
  // mode=emergency — `now` PLUS disable. The bridge is locked out until
  //   reinstall + Enable. For "we think this bridge is compromised, cut
  //   it off NOW" scenarios.
  const modeParam = c.req.query('mode');
  const mode: 'staged' | 'now' | 'emergency' =
    modeParam === 'emergency' ? 'emergency' : modeParam === 'now' ? 'now' : 'staged';
  const graceSeconds = parseGraceSeconds(c.req.query('grace_seconds'));

  const existing = await c.env.DB.prepare(
    `SELECT id, name, cf_dns_token_id, ts_authkey_id, disabled_at, hmac_pending_rotated_at
     FROM bridges WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: string;
      name: string;
      cf_dns_token_id: string | null;
      ts_authkey_id: string | null;
      disabled_at: string | null;
      hmac_pending_rotated_at: string | null;
    }>();
  if (!existing) return buildError(c, 'not_found', 'bridge not found');
  // A staged roll relies on the bridge heartbeating to ack the new key.
  // A disabled/deregistered node won't, so the grace window is dead time
  // and the old key would linger needlessly — force an immediate roll.
  if (mode === 'staged' && existing.disabled_at != null) {
    return buildError(
      c,
      'conflict',
      'staged roll needs a live bridge to ack; use mode=now for a disabled bridge',
    );
  }
  if (mode === 'staged' && existing.hmac_pending_rotated_at) {
    return buildError(
      c,
      'conflict',
      'a staged roll is already in flight for this bridge; wait for it to ack or expire',
    );
  }
  const wasDisabled = existing.disabled_at != null;
  const secret = generateSecret();
  const hashed = await hashSecret(secret, c.env.ARGON2_PEPPER);
  const nowIso = new Date().toISOString();

  // Mint CF + TS BEFORE touching D1, same atomicity discipline as
  // register. Both are rotated immediately for both modes — only the
  // HMAC has a staged/grace concept.
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

  let graceExpiresAt: string | null = null;
  let directiveId: string | null = null;

  if (mode === 'staged') {
    // HMAC stays as bridge_plain (old) + bridge_plain_next (new).
    // Don't touch hmac_key_secret_name or hmac_rotated_at yet — both
    // get set on ack (or by the expire cron at grace_expires_at).
    await c.env.KV_KEY_CACHE.put(bridgePlainNextKvKey(id), secret, {
      expirationTtl: graceSeconds + 120, // a little slack past the directive deadline
    });
    graceExpiresAt = new Date(Date.now() + graceSeconds * 1000).toISOString();
    directiveId = ulid();
    // Staged is enabled-only (guarded above), so the enable state is
    // already clear — don't touch disabled_at here.
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE bridges
           SET cf_dns_token_id = ?, ts_authkey_id = ?,
               hmac_pending_rotated_at = ?,
               installer_window_expires_at = ?
         WHERE id = ?`,
      ).bind(cfMinted.tokenId, tsMinted.key?.id ?? null, nowIso, installerWindowExpiry(nowIso), id),
      c.env.DB.prepare(
        `INSERT INTO bridge_directives
           (id, bridge_id, kind, payload, queued_at, expires_at)
         VALUES (?, ?, 'roll_hmac', ?, ?, ?)`,
      ).bind(
        directiveId,
        id,
        JSON.stringify({ new_hmac_key: secret, grace_expires_at: graceExpiresAt }),
        nowIso,
        graceExpiresAt,
      ),
    ]);
  } else {
    // Immediate roll (now | emergency): swap the HMAC in place — no
    // grace window, the old key stops verifying at once. Drop any
    // pending-roll plaintext so a stale staged roll doesn't keep the old
    // key alive. `emergency` also disables the bridge (lock-out NOW);
    // `now` preserves the existing enable state (re-key a live bridge, or
    // re-key a node that's already disabled/deregistered).
    const newDisabledAt = mode === 'emergency' ? nowIso : existing.disabled_at;
    await c.env.DB.prepare(
      `UPDATE bridges
         SET hmac_key_secret_name = ?, cf_dns_token_id = ?, ts_authkey_id = ?,
             hmac_rotated_at = ?, hmac_pending_rotated_at = NULL,
             disabled_at = ?, installer_window_expires_at = ?
       WHERE id = ?`,
    )
      .bind(
        hashed,
        cfMinted.tokenId,
        tsMinted.key?.id ?? null,
        nowIso,
        newDisabledAt,
        installerWindowExpiry(nowIso),
        id,
      )
      .run();
    await c.env.KV_KEY_CACHE.put(bridgePlainKvKey(id), secret, {
      expirationTtl: FLOOR_S,
    });
    await c.env.KV_KEY_CACHE.delete(bridgePlainNextKvKey(id));
  }

  // CF + TS plaintext KV writes (immediate for both modes).
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

  // Best-effort revokes of the prior CF + TS tokens. (HMAC is plaintext
  // in KV and gets retired by the ack or expire path.)
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
    meta: { name: existing.name, mode, ...(directiveId ? { directive_id: directiveId } : {}) },
  });
  if (mode === 'staged' && directiveId) {
    await audit(c.env, {
      actor: actorOf(c),
      action: 'bridge.directive.queue',
      target: id,
      meta: {
        directive_id: directiveId,
        kind: 'roll_hmac',
        grace_expires_at: graceExpiresAt,
      },
    });
  }
  if (mode === 'emergency' && !wasDisabled) {
    await audit(c.env, {
      actor: actorOf(c),
      action: 'bridge.disable',
      target: id,
      meta: { reason: 'rotate.emergency' },
    });
  }
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

  return c.json({
    id,
    hmac_key: secret,
    installer_url: installerUrlFor(c.env, id, secret),
    mode,
    grace_expires_at: graceExpiresAt,
    directive_id: directiveId,
  });
});

// --- Bridge settings ---------------------------------------------------------
// One row per bridge in `bridge_settings` (inserted defaulted on
// register). The heartbeat response carries the row whenever the
// bridge's `settings_version` trails the stored version. Panel reads
// + writes via these endpoints.

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
  updated_at: string;
  updated_by: string;
}

function settingsRowToResponse(row: BridgeSettingsRow): Record<string, unknown> {
  return {
    bridge_id: row.bridge_id,
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
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

bridges.get('/v1/admin/bridges/:id/settings', requireScope('admin:read'), async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(`SELECT * FROM bridge_settings WHERE bridge_id = ?`)
    .bind(id)
    .first<BridgeSettingsRow>();
  if (!row) return buildError(c, 'not_found', 'bridge settings not found');
  return c.json(settingsRowToResponse(row));
});

interface SettingsPatch {
  smtps_enabled?: boolean;
  smtps_port?: number;
  smtp_enabled?: boolean;
  smtp_port?: number;
  imaps_enabled?: boolean;
  imaps_port?: number;
  imap_enabled?: boolean;
  imap_port?: number;
  tls_source?: 'auto' | 'manual';
  max_message_size_bytes?: number;
  max_imap_sessions?: number;
  log_level?: 'debug' | 'info' | 'warn' | 'error';
  webhook_enabled?: boolean;
  webhook_url_override?: string | null;
}

const TLS_SOURCES = new Set(['auto', 'manual']);
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function validateSettingsPatch(input: unknown): SettingsPatch | string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return 'body must be an object';
  }
  const p = input as Record<string, unknown>;
  const out: SettingsPatch = {};
  for (const k of [
    'smtps_enabled',
    'smtp_enabled',
    'imaps_enabled',
    'imap_enabled',
    'webhook_enabled',
  ] as const) {
    if (k in p) {
      if (typeof p[k] !== 'boolean') return `${k} must be boolean`;
      out[k] = p[k] as boolean;
    }
  }
  for (const k of ['smtps_port', 'smtp_port', 'imaps_port', 'imap_port'] as const) {
    if (k in p) {
      const v = p[k];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 65535) {
        return `${k} must be an integer 1-65535`;
      }
      out[k] = v;
    }
  }
  if ('tls_source' in p) {
    const v = p.tls_source;
    if (typeof v !== 'string' || !TLS_SOURCES.has(v)) return 'tls_source must be auto|manual';
    out.tls_source = v as 'auto' | 'manual';
  }
  if ('max_message_size_bytes' in p) {
    const v = p.max_message_size_bytes;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1024 || v > 1024 * 1024 * 1024) {
      return 'max_message_size_bytes must be an integer 1024..1073741824';
    }
    out.max_message_size_bytes = v;
  }
  if ('max_imap_sessions' in p) {
    const v = p.max_imap_sessions;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 10000) {
      return 'max_imap_sessions must be an integer 1..10000';
    }
    out.max_imap_sessions = v;
  }
  if ('log_level' in p) {
    const v = p.log_level;
    if (typeof v !== 'string' || !LOG_LEVELS.has(v)) {
      return 'log_level must be debug|info|warn|error';
    }
    out.log_level = v as 'debug' | 'info' | 'warn' | 'error';
  }
  if ('webhook_url_override' in p) {
    const v = p.webhook_url_override;
    if (v === null || v === '') {
      out.webhook_url_override = null;
    } else if (typeof v === 'string' && /^https?:\/\//.test(v) && v.length <= 1024) {
      out.webhook_url_override = v;
    } else {
      return 'webhook_url_override must be an http(s) URL ≤1024 chars, or null/empty for auto-derive';
    }
  }
  return out;
}

bridges.put('/v1/admin/bridges/:id/settings', requireScope('admin:rotate'), async (c) => {
  const id = c.req.param('id');
  let body: unknown;
  try {
    body = JSON.parse(bodyText(c) || '{}');
  } catch {
    return buildError(c, 'bad_request', 'invalid json');
  }
  const patch = validateSettingsPatch(body);
  if (typeof patch === 'string') return buildError(c, 'bad_request', patch);

  const existing = await c.env.DB.prepare(`SELECT * FROM bridge_settings WHERE bridge_id = ?`)
    .bind(id)
    .first<BridgeSettingsRow>();
  if (!existing) return buildError(c, 'not_found', 'bridge settings not found');

  // Build the diff for audit + the SET clauses. Only emit a write +
  // version bump when at least one field actually changes.
  const updates: string[] = [];
  const binds: (string | number | null)[] = [];
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  const set = <K extends keyof SettingsPatch>(
    col: K,
    sqlVal: string | number | null,
    rowVal: unknown,
  ): void => {
    updates.push(`${String(col)} = ?`);
    binds.push(sqlVal);
    diff[String(col)] = { from: rowVal, to: patch[col] };
  };
  // Five enable toggles (SMTPS/SMTP/IMAPS/IMAP + webhook).
  for (const k of [
    'smtps_enabled',
    'smtp_enabled',
    'imaps_enabled',
    'imap_enabled',
    'webhook_enabled',
  ] as const) {
    if (patch[k] !== undefined && patch[k] !== (existing[k] === 1)) {
      set(k, patch[k] ? 1 : 0, existing[k] === 1);
    }
  }
  // Four port columns.
  for (const k of ['smtps_port', 'smtp_port', 'imaps_port', 'imap_port'] as const) {
    if (patch[k] !== undefined && patch[k] !== existing[k]) {
      set(k, patch[k] as number, existing[k]);
    }
  }
  if (patch.tls_source !== undefined && patch.tls_source !== existing.tls_source) {
    set('tls_source', patch.tls_source, existing.tls_source);
  }
  if (
    patch.max_message_size_bytes !== undefined &&
    patch.max_message_size_bytes !== existing.max_message_size_bytes
  ) {
    set('max_message_size_bytes', patch.max_message_size_bytes, existing.max_message_size_bytes);
  }
  if (
    patch.max_imap_sessions !== undefined &&
    patch.max_imap_sessions !== existing.max_imap_sessions
  ) {
    set('max_imap_sessions', patch.max_imap_sessions, existing.max_imap_sessions);
  }
  if (patch.log_level !== undefined && patch.log_level !== existing.log_level) {
    set('log_level', patch.log_level, existing.log_level);
  }
  if (
    patch.webhook_url_override !== undefined &&
    patch.webhook_url_override !== existing.webhook_url_override
  ) {
    // Caller sends null/empty for auto-derive; store as SQL NULL.
    set(
      'webhook_url_override',
      patch.webhook_url_override ? patch.webhook_url_override : null,
      existing.webhook_url_override,
    );
  }

  if (updates.length === 0) {
    return c.json(settingsRowToResponse(existing));
  }

  const nowIso = new Date().toISOString();
  const actor = actorOf(c);
  const newVersion = existing.version + 1;
  updates.push('version = ?', 'updated_at = ?', 'updated_by = ?');
  binds.push(newVersion, nowIso, actor);
  binds.push(id);
  await c.env.DB.prepare(`UPDATE bridge_settings SET ${updates.join(', ')} WHERE bridge_id = ?`)
    .bind(...binds)
    .run();

  await audit(c.env, {
    actor,
    action: 'bridge.settings.update',
    target: id,
    meta: { version: newVersion, diff },
  });

  const updated = await c.env.DB.prepare(`SELECT * FROM bridge_settings WHERE bridge_id = ?`)
    .bind(id)
    .first<BridgeSettingsRow>();
  return c.json(settingsRowToResponse(updated as BridgeSettingsRow));
});

// Re-enable a disabled bridge without rotating the HMAC.
bridges.post('/v1/admin/bridges/:id/enable', requireScope('admin:rotate'), async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(`SELECT id, name, disabled_at FROM bridges WHERE id = ?`)
    .bind(id)
    .first<{ id: string; name: string; disabled_at: string | null }>();
  if (!row) return buildError(c, 'not_found', 'bridge not found');
  if (row.disabled_at == null) return c.json({ id, disabled_at: null });
  await c.env.DB.prepare(`UPDATE bridges SET disabled_at = NULL WHERE id = ?`).bind(id).run();
  await audit(c.env, {
    actor: actorOf(c),
    action: 'bridge.enable',
    target: id,
    meta: { name: row.name, reason: 'manual' },
  });
  return c.json({ id, disabled_at: null });
});

// DELETE has two modes:
//   * Default (soft) — sets `disabled_at`. The row stays for audit /
//     message-attribution purposes; the HMAC key is rejected on
//     subsequent requests.
//   * `?hard=true`   — physically removes the row. Requires the bridge
//     to already be soft-disabled. Any messages still
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
    // Heartbeat v2: keep the HMAC plaintext in KV so the bridge can
    // still authenticate the heartbeat endpoint and receive the
    // `enabled: false` signal. Every other bridge-facing endpoint is
    // already gated by `lookupBridgeSecrets()`'s row check (returns
    // `code: 'disabled'` when allowDisabled is false), so the bridge
    // can't submit messages or fetch config while disabled.
    await audit(c.env, {
      actor: actorOf(c),
      action: 'bridge.disable',
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
      'bridge must be disabled before it can be permanently deleted',
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

// Latest heartbeat snapshot. `payload` is the parsed BridgeHeartbeatRequest
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
      const parsed = BridgeHeartbeatRequest.safeParse(JSON.parse(row.last_heartbeat_json));
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

// Bridge log tail. Reads R2 objects under `bridge-logs/<id>/`
// (written by the heartbeat handler, one JSONL chunk per heartbeat
// with new lines) and returns them flattened newest-first by default,
// with optional pagination via a `since` cursor that's the R2 key the
// last response stopped at.
//
// Query params:
//   * limit  — max lines to return (default 200, capped at 2000)
//   * since  — R2 key of the last object included in the previous
//              response (exclusive). Omit on first call.
//   * order  — `desc` (default; newest first) or `asc`
bridges.get('/v1/admin/bridges/:id/logs', requireScope('admin:read'), async (c) => {
  const id = c.req.param('id');
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) {
    return buildError(c, 'bad_request', 'invalid bridge id');
  }
  const limitRaw = Number.parseInt(c.req.query('limit') ?? '200', 10);
  const limit = Math.min(2000, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 200));
  const since = c.req.query('since') ?? undefined;
  const order = c.req.query('order') === 'asc' ? 'asc' : 'desc';

  // R2 list() with a prefix walks the bucket lexicographically by key.
  // Our keys are `bridge-logs/<id>/<YYYY-MM-DD>/<RFC3339>.jsonl`, which
  // sorts to chronological order naturally. We pull 100 keys per page
  // until we have enough lines or run out.
  const prefix = `bridge-logs/${id}/`;
  const lines: unknown[] = [];
  let cursor: string | undefined;
  let lastKey: string | null = null;
  let done = false;
  while (!done && lines.length < limit) {
    const page: R2Objects = await c.env.R2.list({
      prefix,
      cursor,
      limit: 100,
    });
    // R2 returns keys in ascending order. For `order=desc` we reverse
    // the slice; the `since` cursor is honoured AFTER ordering.
    const objects = order === 'desc' ? [...page.objects].reverse() : page.objects;
    for (const obj of objects) {
      if (since && obj.key === since) continue;
      if (since && order === 'desc' && obj.key >= since) continue;
      if (since && order === 'asc' && obj.key <= since) continue;
      const body = await c.env.R2.get(obj.key);
      if (!body) continue;
      const text = await body.text();
      for (const raw of text.split('\n')) {
        if (!raw) continue;
        try {
          lines.push(JSON.parse(raw));
        } catch {
          // Skip malformed lines; the chunk format is well-known
          // (heartbeat handler writes JSONL via JSON.stringify) so
          // garbage here would be storage corruption.
        }
        if (lines.length >= limit) break;
      }
      lastKey = obj.key;
      if (lines.length >= limit) break;
    }
    if (!page.truncated) {
      done = true;
    } else {
      cursor = page.cursor;
    }
  }

  return c.json({
    bridge_id: id,
    order,
    limit,
    lines,
    // Caller passes this back as `since` on the next call to paginate.
    // Null when we exhausted the available log objects.
    next_cursor: lastKey,
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
