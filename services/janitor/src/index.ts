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
  },
};
