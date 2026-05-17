// Daily: walk the audit_log chained-hash chain end-to-end and alert on any
// break. The chain is also continuously self-checked at write time (every
// `audit()` call uses the previous row's row_hash); this daily sweep
// catches drift from out-of-band rewrites that bypass `audit()`.
//
// Result lands in cron_runs so the panel can surface "audit chain verified
// X minutes ago" and turn red on the first break.
import { verifyChain } from '../audit.js';
import type { Env } from '../env.js';
import { recordCronRun } from './cron-runs.js';

export async function auditVerify(env: Env): Promise<void> {
  const start = Date.now();
  const result = await verifyChain(env, 0);
  if (result.ok) {
    await recordCronRun(env, 'audit-verify', 'ok', Date.now() - start);
    return;
  }
  const msg = `chain broken at id=${result.brokenAt}: ${result.reason}`;
  // eslint-disable-next-line no-console
  console.error(
    'audit-verify: chain integrity failure',
    JSON.stringify({
      event: 'audit_chain_broken',
      broken_at: result.brokenAt,
      reason: result.reason,
    }),
  );
  await recordCronRun(env, 'audit-verify', 'error', Date.now() - start, msg);
}
