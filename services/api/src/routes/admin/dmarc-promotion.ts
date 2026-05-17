// W8 — Admin REST over DMARC promotion state.
//
// Endpoints:
//   GET    /v1/admin/dmarc-promotion           — fleet view
//   POST   /v1/admin/dmarc-promotion/:id/pause — manual pause (approval-gated)
//   POST   /v1/admin/dmarc-promotion/:id/resume— back to mode='auto'
//   POST   /v1/admin/dmarc-promotion/:id/claim-management — opt in to DNS writes
//   POST   /v1/admin/dmarc-promotion/run       — manual cron trigger (approval-gated)
import { Hono } from 'hono';
import { requireScope } from '../../auth.js';
import { actorOf, audit } from '../../audit.js';
import { dmarcPromoteRun } from '../../scheduled/dmarc-promote.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const dmarcPromotion = new Hono<{ Bindings: Env }>();

dmarcPromotion.get('/v1/admin/dmarc-promotion', requireScope('admin:read'), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, name, dmarc_policy, dmarc_promotion_mode, dmarc_promotion_state,
            dmarc_promotion_last_at, dmarc_record_managed_by_polaris
     FROM mail_domains
     WHERE status NOT IN ('disabled')
     ORDER BY name`,
  ).all<{
    id: string;
    name: string;
    dmarc_policy: string | null;
    dmarc_promotion_mode: string;
    dmarc_promotion_state: string;
    dmarc_promotion_last_at: string | null;
    dmarc_record_managed_by_polaris: number;
  }>();
  return c.json({ data: rows.results ?? [] });
});

dmarcPromotion.post(
  '/v1/admin/dmarc-promotion/:id/pause',
  requireScope('admin:rotate'),
  async (c) => {
    const id = c.req.param('id');
    const r = await c.env.DB.prepare(
      `UPDATE mail_domains SET dmarc_promotion_mode = 'paused', updated_at = ? WHERE id = ?`,
    )
      .bind(new Date().toISOString(), id)
      .run();
    if (r.meta.changes === 0) return buildError(c, 'not_found', 'domain not found');
    await audit(c.env, {
      actor: actorOf(c),
      action: 'dmarc.pause',
      target: id,
      meta: { source: 'operator' },
    });
    return c.json({ id, dmarc_promotion_mode: 'paused' });
  },
);

dmarcPromotion.post(
  '/v1/admin/dmarc-promotion/:id/resume',
  requireScope('admin:rotate'),
  async (c) => {
    const id = c.req.param('id');
    const r = await c.env.DB.prepare(
      `UPDATE mail_domains SET dmarc_promotion_mode = 'auto', updated_at = ? WHERE id = ?`,
    )
      .bind(new Date().toISOString(), id)
      .run();
    if (r.meta.changes === 0) return buildError(c, 'not_found', 'domain not found');
    await audit(c.env, {
      actor: actorOf(c),
      action: 'dmarc.promote',
      target: id,
      meta: { source: 'resume', new_mode: 'auto' },
    });
    return c.json({ id, dmarc_promotion_mode: 'auto' });
  },
);

dmarcPromotion.post(
  '/v1/admin/dmarc-promotion/:id/claim-management',
  requireScope('admin:rotate'),
  async (c) => {
    const id = c.req.param('id');
    const r = await c.env.DB.prepare(
      `UPDATE mail_domains SET dmarc_record_managed_by_polaris = 1, updated_at = ? WHERE id = ?`,
    )
      .bind(new Date().toISOString(), id)
      .run();
    if (r.meta.changes === 0) return buildError(c, 'not_found', 'domain not found');
    await audit(c.env, {
      actor: actorOf(c),
      action: 'dmarc.claim_management',
      target: id,
      meta: { source: 'operator' },
    });
    return c.json({ id, dmarc_record_managed_by_polaris: 1 });
  },
);

dmarcPromotion.post('/v1/admin/dmarc-promotion/run', requireScope('admin:rotate'), async (c) => {
  const r = await dmarcPromoteRun(c.env);
  return c.json(r);
});
