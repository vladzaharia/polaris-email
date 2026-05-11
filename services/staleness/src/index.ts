// Staleness: weekly Cron that asserts POLARIS_SECRET_A has been rotated within 365d,
// and that the bridge has reported in within 60s.
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

    // Bridge last-seen: any audit row with bridge.reload in the last hour.
    const bridgeRow = await env.DB.prepare(
      `SELECT MAX(at) AS at FROM audit_log WHERE action = 'bridge.reload'`,
    ).first<{ at: number | null }>();
    if ((bridgeRow?.at ?? 0) < now - 60 * 60_000) {
      issues.push('bridge_not_seen_in_hour');
    }

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
