// Admin REST over DMARC promotion state.
//
// Polaris recommends; the auto-promotion cron and/or operators advance
// the policy through Cloudflare DMARC Management (via setDmarcPolicy).
// Polaris does not own the _dmarc TXT record.
//
//   GET    /v1/admin/dmarc-promotion              — fleet view
//   POST   /v1/admin/dmarc-promotion/:id/pause    — manual pause
//   POST   /v1/admin/dmarc-promotion/:id/resume   — back to mode='auto'
//   POST   /v1/admin/dmarc-promotion/:id/advance  — operator advance via CF
//   POST   /v1/admin/dmarc-promotion/run          — manual cron trigger
import { Hono } from 'hono';
import { CloudflareApiClient, setDmarcPolicy } from '@polaris-mail/cf-api';
import { requireScope } from '../../auth.js';
import { actorOf, audit } from '../../audit.js';
import { dmarcPromoteRun } from '../../scheduled/dmarc-promote.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const dmarcPromotion = new Hono<{ Bindings: Env }>();

dmarcPromotion.get('/v1/admin/dmarc-promotion', requireScope('admin:read'), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, name, dmarc_policy, dmarc_promotion_mode, dmarc_promotion_state,
            dmarc_promotion_last_at
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
  '/v1/admin/dmarc-promotion/:id/advance',
  requireScope('admin:rotate'),
  async (c) => {
    const id = c.req.param('id');
    const domain = await c.env.DB.prepare(
      `SELECT d.id, d.name, d.dmarc_promotion_state,
              COALESCE(z.cf_zone_id, d.cf_zone_id) AS cf_zone_id
       FROM mail_domains d LEFT JOIN zones z ON z.id = d.zone_id
       WHERE d.id = ?`,
    )
      .bind(id)
      .first<{
        id: string;
        name: string;
        dmarc_promotion_state: string;
        cf_zone_id: string | null;
      }>();
    if (!domain) return buildError(c, 'not_found', 'domain not found');
    if (!domain.cf_zone_id) {
      return buildError(c, 'bad_request', 'domain has no associated CF zone');
    }
    const next = nextStateFor(domain.dmarc_promotion_state);
    if (!next) {
      return buildError(
        c,
        'conflict',
        `cannot advance from state '${domain.dmarc_promotion_state}'`,
      );
    }
    if (!c.env.CF_API_TOKEN || !c.env.CF_ACCOUNT_ID) {
      return buildError(c, 'degraded', 'CF credentials missing');
    }

    const client = new CloudflareApiClient({
      apiToken: c.env.CF_API_TOKEN,
      accountId: c.env.CF_ACCOUNT_ID,
    });
    try {
      await setDmarcPolicy(client, domain.cf_zone_id, next.policy);
    } catch (err) {
      return buildError(
        c,
        'cf_upstream',
        `cf setDmarcPolicy: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const nowIso = new Date().toISOString();
    await c.env.DB.prepare(
      `UPDATE mail_domains
         SET dmarc_promotion_state = ?,
             dmarc_promotion_last_at = ?,
             dmarc_policy = ?,
             updated_at = ?
       WHERE id = ?`,
    )
      .bind(next.state, nowIso, next.policy, nowIso, id)
      .run();
    await audit(c.env, {
      actor: actorOf(c),
      action: 'dmarc.promote',
      target: id,
      meta: { source: 'operator_advance', from: domain.dmarc_promotion_state, to: next.state },
    });
    return c.json({ id, dmarc_promotion_state: next.state, dmarc_policy: next.policy });
  },
);

dmarcPromotion.post('/v1/admin/dmarc-promotion/run', requireScope('admin:rotate'), async (c) => {
  const r = await dmarcPromoteRun(c.env);
  return c.json(r);
});

// Operator advance is an explicit override: it walks the same policy ladder
// (none → quarantine → reject) the cron does, but skips the soak-gated
// `*_ready` checkpoints. Advancing from `none`/`quarantine` is the operator
// taking responsibility for tightening the policy ahead of the auto schedule.
function nextStateFor(state: string): { state: string; policy: 'quarantine' | 'reject' } | null {
  if (state === 'none' || state === 'quarantine_ready') {
    return { state: 'quarantine', policy: 'quarantine' };
  }
  if (state === 'quarantine' || state === 'reject_ready') {
    return { state: 'reject', policy: 'reject' };
  }
  return null;
}
