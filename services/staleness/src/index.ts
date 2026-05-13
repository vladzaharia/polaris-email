// Staleness: weekly Cron that asserts the control-plane signing secret has been
// rotated within the past 365 days. The bridge.reload check was retired with
// the submission-daemon migration — daemons are observed via their own
// audit actions, not this cron.
interface Env {
  DB: D1Database;
  ALERT_WEBHOOK: string;
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const issues: string[] = [];
    const lastRot = await env.DB.prepare(
      `SELECT MAX(at) AS at FROM audit_log WHERE action = 'schema.migration' AND target = 'control_plane_secret'`,
    ).first<{ at: number | null }>();
    const now = Date.now();
    const stale = (lastRot?.at ?? 0) < now - 365 * 86400_000;
    if (stale) issues.push('control_plane_secret_overdue');

    if (issues.length && env.ALERT_WEBHOOK) {
      try {
        await fetch(env.ALERT_WEBHOOK, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ service: 'polaris-email', staleness: issues }),
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('staleness alert failed', e);
      }
    }
  },
};
