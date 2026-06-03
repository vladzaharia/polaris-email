// bridge-roll-rotate — daily HMAC auto-rotation cron.
//
// Selector: `bridges` with `disabled_at IS NULL`,
// `hmac_pending_rotated_at IS NULL`, and `hmac_rotated_at < now - 30d`.
// Each eligible bridge gets a staged roll queued (same machinery as
// the operator-initiated staged roll via POST /v1/admin/bridges/:id/
// rotate?mode=staged): mint new HMAC, KV bridge_plain_next, queue a
// `roll_hmac` directive with a 1h grace window. The bridge applies +
// acks on its next heartbeat; the expire cron sweeps stragglers.
//
// CF DNS + TS auth keys ride along with the HMAC rotation, same as
// the manual rotate path — only the HMAC has a staged/grace concept.
//
// Telemetry: this returns a count summary so the cron-runs wrapper
// can log the outcome.

import { ulid } from '@polaris-mail/ids';
import { generateSecret } from '@polaris-mail/hmac';
import type { Env } from '../env.js';
import { audit } from '../audit.js';
import { bridgePlainNextKvKey } from '../bridge-auth.js';
import {
  bridgeCfDnsPlainKvKey,
  BRIDGE_CF_DNS_PLAIN_KV_TTL_SECONDS,
  mintCfDnsTokenForBridge,
  revokeCfDnsTokenBestEffort,
} from '../bridge-cf-token.js';
import {
  bridgeTsAuthkeyPlainKvKey,
  BRIDGE_TS_AUTHKEY_PLAIN_KV_TTL_SECONDS,
  mintTsAuthKeyForBridge,
  revokeTsAuthKeyBestEffort,
} from '../bridge-ts-token.js';

/** 30 days in ms — the rotation cadence. */
const ROTATION_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** 1 hour grace window for the staged delivery. */
const AUTO_GRACE_SECONDS = 60 * 60;

export interface RollRotateResult {
  candidates: number;
  rolled: number;
  failed: number;
}

export async function bridgeRollRotate(env: Env): Promise<RollRotateResult> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const ageThreshold = new Date(nowMs - ROTATION_AGE_MS).toISOString();

  const rows = await env.DB.prepare(
    `SELECT id, name, cf_dns_token_id, ts_authkey_id
       FROM bridges
      WHERE disabled_at IS NULL
        AND hmac_pending_rotated_at IS NULL
        AND (hmac_rotated_at IS NULL OR hmac_rotated_at < ?)`,
  )
    .bind(ageThreshold)
    .all<{
      id: string;
      name: string;
      cf_dns_token_id: string | null;
      ts_authkey_id: string | null;
    }>();

  let rolled = 0;
  let failed = 0;
  for (const row of rows.results) {
    try {
      await rollOne(env, row, nowIso);
      rolled += 1;
    } catch (e) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.warn(`bridge-roll-rotate: ${row.id} failed: ${String(e)}`);
    }
  }
  return { candidates: rows.results.length, rolled, failed };
}

async function rollOne(
  env: Env,
  existing: {
    id: string;
    name: string;
    cf_dns_token_id: string | null;
    ts_authkey_id: string | null;
  },
  nowIso: string,
): Promise<void> {
  const secret = generateSecret();
  const cfMinted = await mintCfDnsTokenForBridge(env, existing.name, existing.id);
  let tsMinted: Awaited<ReturnType<typeof mintTsAuthKeyForBridge>>;
  try {
    tsMinted =
      existing.ts_authkey_id != null
        ? await mintTsAuthKeyForBridge(env, existing.name)
        : { key: null };
  } catch (e) {
    if (cfMinted.tokenId) await revokeCfDnsTokenBestEffort(env, cfMinted.tokenId);
    throw e;
  }

  const directiveId = ulid();
  const graceExpiresAt = new Date(Date.parse(nowIso) + AUTO_GRACE_SECONDS * 1000).toISOString();

  await env.KV_KEY_CACHE.put(bridgePlainNextKvKey(existing.id), secret, {
    expirationTtl: AUTO_GRACE_SECONDS + 120,
  });
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE bridges
         SET cf_dns_token_id = ?, ts_authkey_id = ?, hmac_pending_rotated_at = ?
       WHERE id = ?`,
    ).bind(cfMinted.tokenId, tsMinted.key?.id ?? null, nowIso, existing.id),
    env.DB.prepare(
      `INSERT INTO bridge_directives (id, bridge_id, kind, payload, queued_at, expires_at)
       VALUES (?, ?, 'roll_hmac', ?, ?, ?)`,
    ).bind(
      directiveId,
      existing.id,
      JSON.stringify({ new_hmac_key: secret, grace_expires_at: graceExpiresAt }),
      nowIso,
      graceExpiresAt,
    ),
  ]);

  if (cfMinted.plaintext) {
    await env.KV_KEY_CACHE.put(bridgeCfDnsPlainKvKey(existing.id), cfMinted.plaintext, {
      expirationTtl: BRIDGE_CF_DNS_PLAIN_KV_TTL_SECONDS,
    });
  }
  if (tsMinted.key) {
    await env.KV_KEY_CACHE.put(bridgeTsAuthkeyPlainKvKey(existing.id), tsMinted.key.value, {
      expirationTtl: BRIDGE_TS_AUTHKEY_PLAIN_KV_TTL_SECONDS,
    });
  }

  if (existing.cf_dns_token_id) {
    void revokeCfDnsTokenBestEffort(env, existing.cf_dns_token_id);
    await audit(env, {
      actor: 'system:bridge-roll-rotate',
      action: 'bridge.cf_token.revoke',
      target: existing.id,
      meta: { token_id: existing.cf_dns_token_id, reason: 'rotate' },
    });
  }
  if (existing.ts_authkey_id) {
    void revokeTsAuthKeyBestEffort(env, existing.ts_authkey_id);
    await audit(env, {
      actor: 'system:bridge-roll-rotate',
      action: 'bridge.ts_authkey.revoke',
      target: existing.id,
      meta: { key_id: existing.ts_authkey_id, reason: 'rotate' },
    });
  }
  await audit(env, {
    actor: 'system:bridge-roll-rotate',
    action: 'bridge.rotate',
    target: existing.id,
    meta: { name: existing.name, mode: 'staged', directive_id: directiveId, auto: true },
  });
  await audit(env, {
    actor: 'system:bridge-roll-rotate',
    action: 'bridge.directive.queue',
    target: existing.id,
    meta: { directive_id: directiveId, kind: 'roll_hmac', grace_expires_at: graceExpiresAt },
  });
  if (cfMinted.tokenId) {
    await audit(env, {
      actor: 'system:bridge-roll-rotate',
      action: 'bridge.cf_token.mint',
      target: existing.id,
      meta: { token_id: cfMinted.tokenId, name: existing.name, reason: 'rotate' },
    });
  }
  if (tsMinted.key) {
    await audit(env, {
      actor: 'system:bridge-roll-rotate',
      action: 'bridge.ts_authkey.mint',
      target: existing.id,
      meta: { key_id: tsMinted.key.id, name: existing.name, reason: 'rotate' },
    });
  }
  // The KV ttl on bridge_plain (current) gets bumped by the next
  // heartbeat from the bridge — the value sits there until the ack
  // promotes the staged plaintext. No explicit refresh here so a
  // missed heartbeat lets the old key naturally fall out after its
  // current TTL elapses.
}
