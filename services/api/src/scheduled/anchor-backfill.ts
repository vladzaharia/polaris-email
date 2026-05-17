// Daily: re-publish audit_anchors rows whose B2 write failed.
//
// On every hourly anchor run, a D1 row lands first, then the B2 PUT is
// attempted; if B2 fails, the row keeps external_ref_at=NULL. This cron
// walks unconfirmed rows and retries the off-platform write. Rows older
// than 7 days are flagged for operator attention rather than silently
// retried forever — that age window covers any plausible B2 outage and
// avoids replaying ancient anchors after a long incident.
import { putObjectWithLock } from '@polaris-email/object-lock';
import type { Env } from '../env.js';
import { recordCronRun } from './cron-runs.js';

const STALE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface AnchorRow {
  id: number;
  last_audit_id: number;
  last_row_hash: string;
  signature: string;
  signed_at: number;
  external_ref: string;
}

export async function anchorBackfill(env: Env): Promise<void> {
  const start = Date.now();
  if (!env.ANCHOR_SIGNING_KEY) {
    await recordCronRun(env, 'anchor-backfill', 'skipped', 0, 'no signing key');
    return;
  }
  const rows = await env.DB.prepare(
    `SELECT id, last_audit_id, last_row_hash, signature, signed_at, external_ref
       FROM audit_anchors
      WHERE external_ref_at IS NULL
        AND external_ref IS NOT NULL
      ORDER BY signed_at ASC
      LIMIT 100`,
  ).all<AnchorRow>();

  let retried = 0;
  let stale = 0;
  let failed = 0;
  const now = Date.now();

  for (const row of rows.results ?? []) {
    const ageMs = now - row.signed_at;
    if (ageMs > STALE_AGE_MS) {
      stale++;
      // eslint-disable-next-line no-console
      console.error(
        'anchor-backfill: stale unconfirmed anchor',
        JSON.stringify({
          event: 'anchor_b2_write_stale',
          audit_anchor_id: row.id,
          external_ref: row.external_ref,
          age_ms: ageMs,
        }),
      );
      continue;
    }
    const payload = {
      service: 'polaris-email',
      last_audit_id: row.last_audit_id,
      last_row_hash: row.last_row_hash,
      signed_at: row.signed_at,
      sig: row.signature,
    };
    try {
      await putObjectWithLock(env, row.external_ref, JSON.stringify(payload));
      const nowIso = new Date().toISOString();
      await env.DB.prepare(`UPDATE audit_anchors SET external_ref_at = ? WHERE id = ?`)
        .bind(nowIso, row.id)
        .run();
      retried++;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : 'unknown';
      // eslint-disable-next-line no-console
      console.warn('anchor-backfill: retry failed', row.id, msg);
    }
  }

  await recordCronRun(
    env,
    'anchor-backfill',
    failed > 0 ? 'error' : 'ok',
    Date.now() - start,
    `retried=${retried} failed=${failed} stale=${stale}`,
  );
}
