// Background domain-verify cron.
//
// Runs hourly. Two passes:
//
//   1. Prime the CF zone listing cache (refreshCfZoneCache) so the
//      panel's Cloudflare-zone section loads from KV (~ms) instead of
//      paying an account-wide CF API inspect on first hit (5s+).
//   2. Iterate every non-disabled mail_domain and call verifyDomain()
//      — the same helper the operator-initiated POST endpoint uses, so
//      the row's `status`, `verified_at`, and DMARC/MTA-STS/TLS-RPT
//      state stay current without operator activity.
//
// Actor: `system` — distinguishes cron-driven audit rows from
// operator-driven ones (which record `operator:<id>` or `key:<kid>`).
//
// Failure handling: per-domain try/catch. One domain's CF API hiccup
// shouldn't bring down the whole pass; we count it as `failed` and
// move on. The cache-prime step is similarly best-effort — a failure
// there only means the next panel hit will pay the live-inspect cost,
// not that the cron should abort.

import { verifyDomain } from '../lib/verify-domain.js';
import { refreshCfZoneCache } from '../routes/admin/cf-zones.js';
import type { Env } from '../env.js';

export interface DomainVerifyRunResult {
  candidates: number;
  verified: number;
  incomplete: number;
  no_creds: number;
  failed: number;
  /** Number of CF zones primed into the KV cache, or null on failure. */
  cf_zones_cached: number | null;
}

export async function domainVerifyRun(env: Env): Promise<DomainVerifyRunResult> {
  // Step 1 — prime the CF zone cache. Failure here is non-fatal; we
  // log + carry on with the per-domain verify pass.
  let cfZonesCached: number | null = null;
  try {
    const primed = await refreshCfZoneCache(env);
    cfZonesCached = primed.skipped ? null : primed.zones;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      'domain-verify cron: cf-zone cache prime failed',
      e instanceof Error ? e.message : 'unknown',
    );
  }

  const rows = await env.DB.prepare(
    `SELECT id FROM mail_domains
      WHERE status != 'disabled' AND disabled_at IS NULL
      ORDER BY last_verify_check_at ASC NULLS FIRST`,
  )
    .all<{ id: string }>()
    .catch(() => ({ results: [] as { id: string }[] }));

  const result: DomainVerifyRunResult = {
    candidates: rows.results.length,
    verified: 0,
    incomplete: 0,
    no_creds: 0,
    failed: 0,
    cf_zones_cached: cfZonesCached,
  };

  for (const row of rows.results) {
    try {
      const { outcome } = await verifyDomain(env, row.id, 'system');
      switch (outcome) {
        case 'verified':
          result.verified += 1;
          break;
        case 'incomplete':
          result.incomplete += 1;
          break;
        case 'no_creds':
          result.no_creds += 1;
          break;
        case 'not_found':
          // Disappeared mid-iteration (race with delete). Treat as
          // failed for telemetry; it's a soft inconsistency, not a
          // real failure.
          result.failed += 1;
          break;
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `domain-verify cron: ${row.id} threw`,
        e instanceof Error ? e.message : 'unknown',
      );
      result.failed += 1;
    }
  }

  return result;
}
