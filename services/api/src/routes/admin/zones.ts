// Admin zones routes. zones rows hold the (id, cf_zone_id, name) for each
// Cloudflare zone we manage; mail_domains.zone_id FKs into it.
import { Hono } from 'hono';
import { audit } from '../../audit.js';
import { requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const zones = new Hono<{ Bindings: Env }>();

interface ZoneRow {
  id: string;
  cf_zone_id: string;
  name: string;
  created_at: string;
}

zones.get('/v1/admin/zones', requireScope('admin:read'), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, cf_zone_id, name, created_at FROM zones ORDER BY name ASC`,
  ).all<ZoneRow>();
  return c.json({ data: rows.results });
});

zones.get('/v1/admin/zones/lookup', requireScope('admin:read'), async (c) => {
  const cfZoneId = c.req.query('cf_zone_id');
  const name = c.req.query('name');
  if (!cfZoneId && !name) return buildError(c, 'bad_request', 'cf_zone_id or name required');
  const row = cfZoneId
    ? await c.env.DB.prepare(
        `SELECT id, cf_zone_id, name, created_at FROM zones WHERE cf_zone_id = ?`,
      )
        .bind(cfZoneId)
        .first<ZoneRow>()
    : await c.env.DB.prepare(`SELECT id, cf_zone_id, name, created_at FROM zones WHERE name = ?`)
        .bind(name)
        .first<ZoneRow>();
  if (!row) return buildError(c, 'not_found', 'zone not found');
  return c.json(row);
});

zones.post('/v1/admin/zones/:id/rotate-dkim', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(`SELECT id, name FROM zones WHERE id = ?`)
    .bind(id)
    .first<{ id: string; name: string }>();
  if (!row) return buildError(c, 'not_found', 'zone not found');
  // Bump every mail_domain in this zone to a rotating DKIM selector.
  // The real selector rotation happens via packages/cf-api/dkim-rotation;
  // here we record the request and emit an audit row. The cron handler
  // picks up the actual CF API call.
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'domain.dkim_rotate',
    target: id,
    meta: { zone: row.name, scope: 'zone' },
  });
  return c.json({ id, status: 'rotation_scheduled' });
});
