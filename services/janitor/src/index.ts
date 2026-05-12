// Janitor: nightly Cron that enforces retention_days per mailbox.
// Anonymises D1 rows past retention and places delete-markers on R2 objects.
// R2 Object Lock blocks actual erasure until lock expiry.
interface Env {
  DB: D1Database;
  R2: R2Bucket;
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const now = Date.now();
    // Find expired messages joined with their mailbox's retention_days.
    const expired = await env.DB.prepare(
      `SELECT m.id AS id, m.r2_key AS r2_key
       FROM messages m
       LEFT JOIN mailboxes b ON b.id = m.mailbox_id
       WHERE m.subject IS NOT NULL
         AND m.created_at < ? - 86400000 * COALESCE(b.retention_days, 90)`,
    )
      .bind(now)
      .all<{ id: string; r2_key: string | null }>();
    let count = 0;
    for (const r of expired.results) {
      if (r.r2_key) {
        try {
          await env.R2.delete(r.r2_key);
        } catch {
          // Object Lock may block; harmless — try the next.
        }
      }
      await env.DB.prepare(
        `UPDATE messages
         SET subject = NULL, r2_key = NULL, last_error = NULL, smtp_response = NULL,
             auth_results_json = NULL, idempotency_key = NULL, updated_at = ?
         WHERE id = ?`,
      )
        .bind(now, r.id)
        .run();
      count++;
    }
    if (count) {
      // eslint-disable-next-line no-console
      console.log('janitor: anonymised', count);
    }
    // Scrub the mox_pending_ops queue. Two rules:
    //   1. Successfully-applied rows older than 5 minutes are no longer needed
    //      by the sidecar and may have carried plaintext password material in
    //      payload_b64 (now redundant — Mox holds the bcrypt). Delete promptly
    //      to minimise the at-rest plaintext window.
    //   2. Persistently-failed rows (attempts ≥ 5) get a 1-hour grace window
    //      so an operator can notice and intervene before they vanish.
    const fiveMinAgo = now - 5 * 60 * 1000;
    const oneHourAgo = now - 60 * 60 * 1000;
    try {
      const appliedDeleted = await env.DB.prepare(
        `DELETE FROM mox_pending_ops WHERE applied_at IS NOT NULL AND applied_at < ?`,
      )
        .bind(fiveMinAgo)
        .run();
      const failedDeleted = await env.DB.prepare(
        `DELETE FROM mox_pending_ops
         WHERE applied_at IS NULL AND attempts >= 5 AND created_at < ?`,
      )
        .bind(oneHourAgo)
        .run();
      const a = appliedDeleted.meta?.changes ?? 0;
      const f = failedDeleted.meta?.changes ?? 0;
      if (a || f) {
        // eslint-disable-next-line no-console
        console.log('janitor: mox_pending_ops scrubbed applied=' + a + ' failed=' + f);
      }
    } catch (e) {
      // Table may not exist on older deploys; harmless.
      // eslint-disable-next-line no-console
      console.warn('janitor: mox_pending_ops scrub error', e instanceof Error ? e.message : e);
    }
  },
};
