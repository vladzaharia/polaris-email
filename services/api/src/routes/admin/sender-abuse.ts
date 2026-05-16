// W2c — Admin surface over sender_abuse_profile + cron trigger.
//
// GET /v1/admin/sender-abuse-profiles
//   List profiles, filter by tier, ordered by last_event_at DESC.
// GET /v1/admin/sender-abuse-profiles/:type/:id
//   Detail view including a per-window event-count snapshot from
//   abuse_events (reuses the W2 summary aggregation).
// POST /v1/admin/sender-abuse-threshold/run
//   Manual trigger for the threshold cron — used by the panel "Run now"
//   button and approval-gated server-side (it can suppress senders, so it's
//   destructive).
import { Hono } from 'hono';
import { requireScope } from '../../auth.js';
import { senderAbuseThresholdRun } from '../../scheduled/sender-abuse-threshold.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const senderAbuse = new Hono<{ Bindings: Env }>();

interface ProfileRow {
  principal_type: string;
  principal_id: string;
  lifetime_event_count: number;
  lifetime_weighted_score: number;
  suppression_count: number;
  current_tier: number;
  current_tier_started_at: string | null;
  last_suppressed_at: string | null;
  last_event_at: string | null;
  created_at: string;
  updated_at: string;
}

senderAbuse.get('/v1/admin/sender-abuse-profiles', requireScope('admin:read'), async (c) => {
  const tier = c.req.query('tier');
  const principalType = c.req.query('principal_type');
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '100'), 1), 500);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (tier !== undefined) {
    where.push('current_tier = ?');
    binds.push(Number(tier));
  }
  if (principalType) {
    where.push('principal_type = ?');
    binds.push(principalType);
  }
  const sql =
    `SELECT * FROM sender_abuse_profile` +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY current_tier DESC, last_event_at DESC LIMIT ?';
  binds.push(limit);
  const rows = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all<ProfileRow>();
  return c.json({ data: rows.results ?? [] });
});

senderAbuse.get(
  '/v1/admin/sender-abuse-profiles/:type/:id',
  requireScope('admin:read'),
  async (c) => {
    const type = c.req.param('type');
    const id = c.req.param('id');
    const row = await c.env.DB.prepare(
      `SELECT * FROM sender_abuse_profile WHERE principal_type = ? AND principal_id = ?`,
    )
      .bind(type, id)
      .first<ProfileRow>();
    if (!row) return buildError(c, 'not_found', 'profile not found');
    return c.json(row);
  },
);

senderAbuse.post(
  '/v1/admin/sender-abuse-threshold/run',
  requireScope('admin:rotate'),
  async (c) => {
    const r = await senderAbuseThresholdRun(c.env);
    return c.json({
      ok: true,
      candidates: r.candidates,
      fired: r.fired,
      details: r.details,
    });
  },
);
