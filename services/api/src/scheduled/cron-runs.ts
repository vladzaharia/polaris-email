// Cron-run telemetry. Each scheduled handler upserts a row into `cron_runs`
// (added in 0020) so the panel can show "last successful anchor 3h ago"
// without scraping Logpush. Records duration_ms and status (ok|error|skipped)
// plus an optional short message.
import type { Env } from '../env.js';

export type CronStatus = 'ok' | 'error' | 'skipped';

export async function recordCronRun(
  env: Env,
  jobName: string,
  status: CronStatus,
  durationMs: number,
  message?: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO cron_runs (job_name, last_run_at, status, duration_ms, message)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(job_name) DO UPDATE SET
         last_run_at = excluded.last_run_at,
         status      = excluded.status,
         duration_ms = excluded.duration_ms,
         message     = excluded.message`,
    )
      .bind(jobName, nowIso, status, durationMs, message ?? null)
      .run();
  } catch (e) {
    // Telemetry failure must not break the cron. Log and continue.
    // eslint-disable-next-line no-console
    console.warn('cron_runs upsert failed', jobName, e instanceof Error ? e.message : 'unknown');
  }
}

// Wrap a cron handler with timing + status reporting. The handler's return
// value is preserved; thrown errors are rethrown after telemetry is written.
export async function withCronTelemetry<T>(
  env: Env,
  jobName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    await recordCronRun(env, jobName, 'ok', Date.now() - start);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordCronRun(env, jobName, 'error', Date.now() - start, msg);
    throw e;
  }
}
