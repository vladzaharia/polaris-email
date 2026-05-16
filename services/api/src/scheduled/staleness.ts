// Weekly: assert the control-plane signing secret has been rotated within
// the past 365 days. Posts to the alert webhook on breach.
//
// The webhook POST goes through `safeFetch` (queue/ssrf.ts) so a misconfigured
// `ALERT_WEBHOOK` can't be turned into a private-network probe from this
// privileged cron context. Skipped silently when `ALERT_WEBHOOK` is unset.
import type { Env } from '../env.js';
import { safeFetch } from '../queue/ssrf.js';

export async function staleness(env: Env): Promise<void> {
  const issues: string[] = [];
  const lastRot = await env.DB.prepare(
    `SELECT MAX(at) AS at FROM audit_log WHERE action = 'schema.migration' AND target = 'control_plane_secret'`,
  ).first<{ at: number | null }>();
  const now = Date.now();
  const stale = (lastRot?.at ?? 0) < now - 365 * 86400_000;
  if (stale) issues.push('control_plane_secret_overdue');

  if (issues.length && env.ALERT_WEBHOOK) {
    try {
      await safeFetch(env.ALERT_WEBHOOK, 'external', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ service: 'polaris-email', staleness: issues }),
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('staleness alert failed', e);
    }
  }
}
