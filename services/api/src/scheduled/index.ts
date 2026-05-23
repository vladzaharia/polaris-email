// Scheduled (cron) dispatcher for polaris-mail-api.
//
// Cron triggers and their handlers (all routed off `event.cron`):
//   * `0 9 * * 1`           — weekly control-plane staleness     → staleness
//   * `*/5 * * * *`         — synthetic /healthz probe (5 min)   → synthetic
//   * `0 3 * * *`           — nightly retention janitor           → janitor
//   * `*/15 * * * *`        — sender abuse threshold              → senderAbuseThresholdRun
//   * `0 2 * * *`           — daily DMARC aggregate mirror        → dmarcMirrorRun
//   * `0 4 * * *`           — daily DMARC policy auto-promotion   → dmarcPromoteRun
//   * `0 */6 * * *`         — MTA-STS continuity                  → mtaStsContinuityRun
//   * `30 */6 * * *`        — DKIM self-verify                    → dkimSelfVerifyRun
//   * `15 * * * *`          — domain verify (hourly DNS+CF sync)   → domainVerifyRun
//   * `0 5 * * *`           — feedback window refresh             → feedbackWindowRefresh
//   * `20 5 * * *`          — full audit chain verification       → auditVerify
//   * `50 5 * * *`          — policy_decision ↔ message backfill  → policyBackfill
//   * `0 6 * * 7`           — weekly D1 export to R2 backups      → d1Backup
//
// Every handler runs inside withCronTelemetry, which writes a row into
// cron_runs with (status, duration_ms, message). audit-verify and
// policy-backfill report their own telemetry (status reflects internal
// partial-success state); everything else gets blanket ok/error from
// the wrapper.
import { auditVerify } from './audit-verify.js';
import { policyBackfill } from './policy-backfill.js';
import { janitor } from './janitor.js';
import { staleness } from './staleness.js';
import { synthetic } from './synthetic.js';
import { senderAbuseThresholdRun } from './sender-abuse-threshold.js';
import { dmarcMirrorRun } from './dmarc-mirror.js';
import { dmarcPromoteRun } from './dmarc-promote.js';
import { mtaStsContinuityRun } from './mta-sts-continuity.js';
import { dkimSelfVerifyRun } from './dkim-self-verify.js';
import { domainVerifyRun } from './domain-verify.js';
import { feedbackWindowRefresh } from './feedback-window-refresh.js';
import { withCronTelemetry } from './cron-runs.js';
import type { Env } from '../env.js';

export async function scheduled(event: ScheduledEvent, env: Env): Promise<void> {
  switch (event.cron) {
    case '0 9 * * 1':
      return withCronTelemetry(env, 'staleness', () => staleness(env));
    case '*/5 * * * *':
      return withCronTelemetry(env, 'synthetic', () => synthetic(env));
    case '0 3 * * *':
      return withCronTelemetry(env, 'janitor', () => janitor(env));
    case '*/15 * * * *':
      await withCronTelemetry(env, 'sender-abuse-threshold', async () => {
        const r = await senderAbuseThresholdRun(env);
        // eslint-disable-next-line no-console
        console.log('sender-abuse-threshold cron:', `candidates=${r.candidates} fired=${r.fired}`);
      });
      return;
    case '0 2 * * *':
      await withCronTelemetry(env, 'dmarc-mirror', async () => {
        const r = await dmarcMirrorRun(env);
        // eslint-disable-next-line no-console
        console.log(
          'dmarc-mirror cron:',
          `zones=${r.zones} rows=${r.rowsUpserted} failed=${r.failed} skipped=${r.skipped}`,
        );
      });
      return;
    case '0 4 * * *':
      await withCronTelemetry(env, 'dmarc-promote', async () => {
        const r = await dmarcPromoteRun(env);
        // eslint-disable-next-line no-console
        console.log(
          'dmarc-promote cron:',
          `candidates=${r.candidates} promoted=${r.promoted} paused=${r.paused} noop=${r.noOp}`,
        );
      });
      return;
    case '0 */6 * * *':
      await withCronTelemetry(env, 'mta-sts-continuity', async () => {
        const r = await mtaStsContinuityRun(env);
        // eslint-disable-next-line no-console
        console.log(
          'mta-sts-continuity cron:',
          `candidates=${r.candidates} ok=${r.ok} failed=${r.failed}`,
        );
      });
      return;
    case '30 */6 * * *':
      await withCronTelemetry(env, 'dkim-self-verify', async () => {
        const r = await dkimSelfVerifyRun(env);
        // eslint-disable-next-line no-console
        console.log(
          'dkim-self-verify cron:',
          `candidates=${r.candidates} ok=${r.ok} failed=${r.failed} skipped=${r.skipped}`,
        );
      });
      return;
    case '15 * * * *':
      await withCronTelemetry(env, 'domain-verify', async () => {
        const r = await domainVerifyRun(env);
        // eslint-disable-next-line no-console
        console.log(
          'domain-verify cron:',
          `candidates=${r.candidates} verified=${r.verified} incomplete=${r.incomplete} ` +
            `no_creds=${r.no_creds} failed=${r.failed} cf_zones_cached=${r.cf_zones_cached ?? 'skipped'}`,
        );
      });
      return;
    case '0 5 * * *':
      await withCronTelemetry(env, 'feedback-window-refresh', async () => {
        const r = await feedbackWindowRefresh(env);
        // eslint-disable-next-line no-console
        console.log('feedback-window-refresh cron:', `written=${r.written}`);
      });
      return;
    case '20 5 * * *':
      return auditVerify(env); // self-reports telemetry
    case '50 5 * * *':
      return policyBackfill(env); // self-reports telemetry
    case '0 6 * * 7':
      // Weekly D1 export to R2. `7` is Sunday in CF's cron parser (it
      // rejects `0` for day-of-week despite docs saying otherwise).
      return withCronTelemetry(env, 'd1-backup', async () => {
        const mod = await import('./d1-backup.js');
        await mod.d1Backup(env);
      });
    default:
      // eslint-disable-next-line no-console
      console.warn(`scheduled: unknown cron ${event.cron}`);
  }
}
