// Background domain-verify cron.
//
// Runs hourly. Iterates every non-disabled mail_domain and calls the
// same verifyDomain() helper the operator-initiated POST endpoint
// uses, so the row's `status`, `verified_at`, and DMARC/MTA-STS/TLS-RPT
// state stay current without an operator having to open the domain
// detail page. The panel's auto-run-on-mount remains as a "I want it
// even fresher than the cron just gave me" affordance.
//
// Actor: `system` — distinguishes cron-driven audit rows from
// operator-driven ones (which record `operator:<id>` or `key:<kid>`).
//
// Failure handling: per-domain try/catch. One domain's CF API hiccup
// shouldn't bring down the whole pass; we count it as `failed` and
// move on.

import { verifyDomain } from '../lib/verify-domain.js';
import type { Env } from '../env.js';

export interface DomainVerifyRunResult {
  candidates: number;
  verified: number;
  incomplete: number;
  no_creds: number;
  failed: number;
}

export async function domainVerifyRun(env: Env): Promise<DomainVerifyRunResult> {
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
