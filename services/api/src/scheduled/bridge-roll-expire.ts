// bridge-roll-expire — sweep pending roll_hmac directives past their
// grace window and complete the rotation server-side.
//
// When a bridge doesn't ack within `expires_at` (because it's offline,
// or it lost the directive in a restart, or the operator picked a
// short grace window and forgot to install), this cron applies the
// pending HMAC server-side: promote `bridge_plain_next` to
// `bridge_plain`, hash the new HMAC into `bridges.hmac_key_secret_name`,
// clear `hmac_pending_rotated_at`, mark the directive expired+acked.
//
// The bridge running with its old HMAC will start failing auth on its
// next heartbeat; the operator's recovery is the curl|sh install URL
// (still discoverable in the panel — it embeds the new HMAC).

import type { Env } from '../env.js';
import { audit } from '../audit.js';
import {
  bridgePlainKvKey,
  bridgePlainNextKvKey,
  BRIDGE_PLAIN_KV_TTL_SECONDS,
} from '../bridge-auth.js';
import { hashSecret } from '../hashing.js';

export interface RollExpireResult {
  candidates: number;
  expired: number;
  failed: number;
}

export async function bridgeRollExpire(env: Env): Promise<RollExpireResult> {
  const nowIso = new Date().toISOString();
  const rows = await env.DB.prepare(
    `SELECT id, bridge_id, payload, expires_at
       FROM bridge_directives
      WHERE kind = 'roll_hmac' AND acked_at IS NULL AND expires_at IS NOT NULL
        AND expires_at < ?`,
  )
    .bind(nowIso)
    .all<{ id: string; bridge_id: string; payload: string; expires_at: string }>();

  let expired = 0;
  let failed = 0;
  for (const row of rows.results) {
    try {
      await expireOne(env, row, nowIso);
      expired += 1;
    } catch (e) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.warn(`bridge-roll-expire: directive ${row.id} failed: ${String(e)}`);
    }
  }
  return { candidates: rows.results.length, expired, failed };
}

async function expireOne(
  env: Env,
  row: { id: string; bridge_id: string; payload: string },
  nowIso: string,
): Promise<void> {
  const payload = JSON.parse(row.payload) as { new_hmac_key?: unknown };
  const newSecret = payload.new_hmac_key;
  if (typeof newSecret !== 'string' || newSecret.length === 0) {
    // Malformed payload — mark the directive expired and move on so we
    // don't keep retrying it.
    await env.DB.prepare(`UPDATE bridge_directives SET acked_at = ? WHERE id = ?`)
      .bind(nowIso, row.id)
      .run();
    return;
  }
  const newHash = await hashSecret(newSecret, env.ARGON2_PEPPER);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE bridges
         SET hmac_key_secret_name = ?,
             hmac_rotated_at = ?,
             hmac_pending_rotated_at = NULL
       WHERE id = ?`,
    ).bind(newHash, nowIso, row.bridge_id),
    env.DB.prepare(`UPDATE bridge_directives SET acked_at = ? WHERE id = ?`).bind(nowIso, row.id),
  ]);
  await env.KV_KEY_CACHE.put(bridgePlainKvKey(row.bridge_id), newSecret, {
    expirationTtl: BRIDGE_PLAIN_KV_TTL_SECONDS,
  });
  await env.KV_KEY_CACHE.delete(bridgePlainNextKvKey(row.bridge_id));
  await audit(env, {
    actor: 'system:bridge-roll-expire',
    action: 'bridge.directive.expire',
    target: row.bridge_id,
    meta: { directive_id: row.id, kind: 'roll_hmac' },
  });
}
