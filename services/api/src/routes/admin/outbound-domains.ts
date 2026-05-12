// Admin REST routes for outbound_domains (the "send-from" peer of the inbound `domains` table).
// All HMAC-signed (admin middleware applied at the parent `admin` Hono instance).
import { Hono } from 'hono';
import {
  CreateOutboundDomainRequest,
  UpdateOutboundDomainRequest,
} from '@polaris-email/schema';
import { audit } from '../../audit.js';
import { bodyText, requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';
import { ulid } from '../../ids.js';

export const outboundDomains = new Hono<{ Bindings: Env }>();

interface OutboundDomainRow {
  id: string;
  domain: string;
  dkim_selector: string;
  status: 'pending' | 'verified' | 'active' | 'disabled';
  cf_zone_id: string | null;
  is_default: number;
  dmarc_policy: 'none' | 'quarantine' | 'reject';
  dmarc_rua: string | null;
  binding_tag: string | null;
  last_verified_at: number | null;
  created_at: number;
  updated_at: number;
  disabled_at: number | null;
}

function deriveBindingTag(domain: string): string {
  // EMAIL_PLRS_IM, EMAIL_POLARIS_VIDEO, etc.
  return domain.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

// ---------- create ----------
outboundDomains.post('/v1/admin/outbound-domains', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  let body;
  try {
    body = CreateOutboundDomainRequest.parse(JSON.parse(bodyText(c)));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  const id = ulid();
  const now = Date.now();
  const selector = body.dkim_selector ?? 'cf2024-1';
  const policy = body.dmarc_policy ?? 'none';
  const rua = body.dmarc_rua ?? `mailto:postmaster@${body.domain}`;
  const bindingTag = body.binding_tag ?? deriveBindingTag(body.domain);
  const isDefault = body.is_default ? 1 : 0;
  try {
    // If this row becomes the new default, demote any existing default.
    if (isDefault === 1) {
      await c.env.DB.prepare(`UPDATE outbound_domains SET is_default = 0 WHERE is_default = 1`).run();
    }
    await c.env.DB.prepare(
      `INSERT INTO outbound_domains
         (id, domain, dkim_selector, status, is_default, dmarc_policy, dmarc_rua, binding_tag, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, body.domain, selector, 'pending', isDefault, policy, rua, bindingTag, now, now)
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return buildError(c, 'conflict', 'domain already registered');
    throw e;
  }
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'outbound_domain.create',
    target: id,
    meta: { domain: body.domain, selector, is_default: isDefault === 1 },
  });
  return c.json(
    {
      id,
      domain: body.domain,
      dkim_selector: selector,
      status: 'pending',
      binding_tag: bindingTag,
      // Convenience: hint at the CNAME target the operator can pre-create. The real
      // value comes back from CF Email Routing once the zone is enabled.
      dkim_cname_hint: `${selector}._domainkey.${body.domain}. CNAME ${selector}._domainkey.<zone>.cf-email-routing.com.`,
      created_at: now,
    },
    201,
  );
});

// ---------- list ----------
outboundDomains.get('/v1/admin/outbound-domains', requireScope('admin:read'), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, domain, dkim_selector, status, cf_zone_id, is_default, dmarc_policy,
            dmarc_rua, binding_tag, last_verified_at, created_at, updated_at, disabled_at
     FROM outbound_domains ORDER BY is_default DESC, domain ASC`,
  ).all<OutboundDomainRow>();
  return c.json({ data: rows.results });
});

// ---------- get one ----------
outboundDomains.get('/v1/admin/outbound-domains/:id', requireScope('admin:read'), async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT id, domain, dkim_selector, status, cf_zone_id, is_default, dmarc_policy,
            dmarc_rua, binding_tag, last_verified_at, created_at, updated_at, disabled_at
     FROM outbound_domains WHERE id = ?`,
  )
    .bind(id)
    .first<OutboundDomainRow>();
  if (!row) return buildError(c, 'not_found', 'outbound_domain not found');
  return c.json(row);
});

// ---------- patch (cache zone id, set status, etc.) ----------
outboundDomains.patch('/v1/admin/outbound-domains/:id', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  const id = c.req.param('id');
  let body;
  try {
    body = UpdateOutboundDomainRequest.parse(JSON.parse(bodyText(c) || '{}'));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  const existing = await c.env.DB.prepare(`SELECT id FROM outbound_domains WHERE id = ?`)
    .bind(id)
    .first<{ id: string }>();
  if (!existing) return buildError(c, 'not_found', 'outbound_domain not found');

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.cf_zone_id !== undefined) {
    sets.push('cf_zone_id = ?');
    binds.push(body.cf_zone_id);
  }
  if (body.status !== undefined) {
    sets.push('status = ?');
    binds.push(body.status);
  }
  if (body.dmarc_policy !== undefined) {
    sets.push('dmarc_policy = ?');
    binds.push(body.dmarc_policy);
  }
  if (body.dmarc_rua !== undefined) {
    sets.push('dmarc_rua = ?');
    binds.push(body.dmarc_rua);
  }
  if (body.binding_tag !== undefined) {
    sets.push('binding_tag = ?');
    binds.push(body.binding_tag);
  }
  if (body.dkim_selector !== undefined) {
    sets.push('dkim_selector = ?');
    binds.push(body.dkim_selector);
  }
  if (body.is_default !== undefined) {
    if (body.is_default) {
      await c.env.DB.prepare(`UPDATE outbound_domains SET is_default = 0 WHERE is_default = 1`).run();
    }
    sets.push('is_default = ?');
    binds.push(body.is_default ? 1 : 0);
  }
  if (sets.length === 0) return buildError(c, 'bad_request', 'no fields to update');
  const now = Date.now();
  sets.push('updated_at = ?');
  binds.push(now);
  binds.push(id);
  await c.env.DB.prepare(
    `UPDATE outbound_domains SET ${sets.join(', ')} WHERE id = ?`,
  )
    .bind(...binds)
    .run();
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'outbound_domain.update',
    target: id,
    meta: { fields: Object.keys(body) },
  });
  return c.json({ id, updated_at: now });
});

// ---------- verify (re-checks zone state) ----------
outboundDomains.post(
  '/v1/admin/outbound-domains/:id/verify',
  requireScope('admin:rotate'),
  async (c) => {
    const key = c.get('apiKey');
    const id = c.req.param('id');
    const row = await c.env.DB.prepare(
      `SELECT id, domain, status FROM outbound_domains WHERE id = ?`,
    )
      .bind(id)
      .first<{ id: string; domain: string; status: string }>();
    if (!row) return buildError(c, 'not_found', 'outbound_domain not found');
    // The actual verification (DKIM resolves, Email Routing zone enabled) is performed by
    // bin/onboard.sh which has the CF API token. This endpoint is the *flip* step: the
    // caller passes the verification result via a PATCH-style update. Here we simply
    // promote pending -> verified if the operator has indicated the records are in place.
    // Real DKIM lookup from a Worker would require DNS-over-HTTPS; out of scope for v1.
    const now = Date.now();
    await c.env.DB.prepare(
      `UPDATE outbound_domains SET status = 'verified', last_verified_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(now, now, id)
      .run();
    await audit(c.env, {
      actor: `key:${key.key_id}`,
      action: 'outbound_domain.verify',
      target: id,
      meta: { domain: row.domain },
    });
    return c.json({ id, status: 'verified', verified_at: now });
  },
);

// ---------- soft-disable ----------
outboundDomains.delete(
  '/v1/admin/outbound-domains/:id',
  requireScope('admin:rotate'),
  async (c) => {
    const key = c.get('apiKey');
    const id = c.req.param('id');
    const now = Date.now();
    const r = await c.env.DB.prepare(
      `UPDATE outbound_domains
       SET status = 'disabled', disabled_at = ?, updated_at = ?
       WHERE id = ? AND disabled_at IS NULL`,
    )
      .bind(now, now, id)
      .run();
    if (r.meta.changes === 0) return buildError(c, 'not_found', 'not found or already disabled');
    await audit(c.env, {
      actor: `key:${key.key_id}`,
      action: 'outbound_domain.disable',
      target: id,
      meta: {},
    });
    return c.json({ id, disabled_at: now });
  },
);
