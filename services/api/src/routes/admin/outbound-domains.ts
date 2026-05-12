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

// ---------- verify (real DNS check via DoH + CF Email Routing) ----------
//
// Resolves the domain's expected DKIM CNAME target from Cloudflare Email Routing's
// /zones/:zone_id/email/routing/dns endpoint, then verifies via Cloudflare DoH
// (https://cloudflare-dns.com/dns-query) that:
//   • The DKIM CNAME(s) point at the expected `*.cf-email-routing.com` host.
//   • The MX records resolve to `routeN.mx.cloudflare.net`.
// On full success, flips status to 'verified'. On partial/failed, leaves status
// unchanged and returns a diagnostic 200 with per-check detail.
//
// The Worker has no DNS resolver of its own; DoH (RFC 8484 / JSON variant) is the
// only outbound DNS path inside a Worker.
interface DohAnswer {
  name: string;
  type: number;
  TTL?: number;
  data: string;
}
interface DohResponse {
  Status: number;
  Answer?: DohAnswer[];
}
interface VerifyCheck {
  name: string;
  ok: boolean;
  expected: string;
  actual: string;
}

// DNS record type codes.
const DNS_CNAME = 5;
const DNS_MX = 15;

async function dohResolve(host: string, type: 'CNAME' | 'MX'): Promise<DohAnswer[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/dns-json' },
    // 5s timeout via AbortSignal so a slow resolver doesn't hang the verify call.
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) return [];
  const j = (await res.json()) as DohResponse;
  // NXDOMAIN / NODATA → Answer may be absent. Treat as empty.
  if (!j.Answer || !Array.isArray(j.Answer)) return [];
  const want = type === 'CNAME' ? DNS_CNAME : DNS_MX;
  return j.Answer.filter((a) => a.type === want);
}

function stripDot(s: string): string {
  return s.endsWith('.') ? s.slice(0, -1) : s;
}

interface RoutingDnsRecord {
  type: string;
  name: string;
  content: string;
  priority?: number;
}
interface CfEnvelope<T> {
  success: boolean;
  result?: T;
}

async function fetchExpectedRoutingDns(
  accountId: string,
  zoneId: string,
  apiToken: string,
): Promise<RoutingDnsRecord[]> {
  // Cloudflare API: GET /zones/:zone_id/email/routing/dns returns the canonical
  // set of MX + DKIM CNAME records that Email Routing wants on this zone.
  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/dns`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${apiToken}`,
      'cf-account-id': accountId,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return [];
  const j = (await res.json()) as CfEnvelope<RoutingDnsRecord[]>;
  if (!j.success || !Array.isArray(j.result)) return [];
  return j.result;
}

outboundDomains.post(
  '/v1/admin/outbound-domains/:id/verify',
  requireScope('admin:rotate'),
  async (c) => {
    const key = c.get('apiKey');
    const id = c.req.param('id');
    const row = await c.env.DB.prepare(
      `SELECT id, domain, status, cf_zone_id FROM outbound_domains WHERE id = ?`,
    )
      .bind(id)
      .first<{ id: string; domain: string; status: string; cf_zone_id: string | null }>();
    if (!row) return buildError(c, 'not_found', 'outbound_domain not found');

    // Env access for CF API token + account id. These may not be present in test
    // environments — degrade gracefully with a check-level error rather than 500.
    const env = c.env as unknown as { CF_API_TOKEN?: string; CF_ACCOUNT_ID?: string };
    const apiToken = env.CF_API_TOKEN;
    const accountId = env.CF_ACCOUNT_ID;

    const checks: VerifyCheck[] = [];

    // 1) Pull expected records from CF Email Routing (DKIM CNAMEs + MX list).
    //    Without CF API credentials or a cached zone id, we cannot self-discover
    //    the expected DKIM CNAME target — return a diagnostic without any
    //    outbound network calls (lets the operator know what's missing).
    let expected: RoutingDnsRecord[] = [];
    const haveCfCreds = !!(apiToken && accountId && row.cf_zone_id);
    if (!haveCfCreds) {
      checks.push({
        name: 'cf-email-routing-dns',
        ok: false,
        expected: 'CF API token + cached zone id',
        actual: 'missing CF_API_TOKEN, CF_ACCOUNT_ID or cf_zone_id',
      });
      await audit(c.env, {
        actor: `key:${key.key_id}`,
        action: 'outbound_domain.verify_incomplete',
        target: id,
        meta: { domain: row.domain, reason: 'no-cf-creds' },
      });
      return c.json({
        id,
        status: row.status,
        message: 'verification incomplete',
        checks,
      });
    }
    expected = await fetchExpectedRoutingDns(accountId!, row.cf_zone_id!, apiToken!).catch(
      () => [],
    );

    // 2) Check each expected DKIM CNAME via DoH.
    for (const rec of expected.filter((r) => r.type.toUpperCase() === 'CNAME')) {
      const want = stripDot(rec.content).toLowerCase();
      const got = await dohResolve(rec.name, 'CNAME').catch(() => []);
      const seen = got.map((a) => stripDot(a.data).toLowerCase());
      checks.push({
        name: `cname:${rec.name}`,
        ok: seen.includes(want),
        expected: want,
        actual: seen.join(',') || '(empty)',
      });
    }

    // 3) Check MX records resolve to routeN.mx.cloudflare.net.
    //    DoH "data" for MX has the form: "<priority> <exchange>."
    const mxAnswers = await dohResolve(row.domain, 'MX').catch(() => []);
    const seenMxHosts = mxAnswers
      .map((a) => stripDot(a.data.split(/\s+/).pop() ?? '').toLowerCase())
      .filter((h) => h.length > 0);
    const expectedMxHosts = expected
      .filter((r) => r.type.toUpperCase() === 'MX')
      .map((r) => stripDot(r.content).toLowerCase());
    // If CF didn't return MX expectations, fall back to the canonical Cloudflare set.
    const fallbackMx = ['route1.mx.cloudflare.net', 'route2.mx.cloudflare.net', 'route3.mx.cloudflare.net'];
    const wantMxSet = (expectedMxHosts.length > 0 ? expectedMxHosts : fallbackMx).sort();
    const haveMxSet = [...new Set(seenMxHosts)].sort();
    const mxOk =
      wantMxSet.length > 0 &&
      wantMxSet.every((h) => haveMxSet.includes(h));
    checks.push({
      name: 'mx',
      ok: mxOk,
      expected: wantMxSet.join(','),
      actual: haveMxSet.join(',') || '(empty)',
    });

    const allOk = checks.length > 0 && checks.every((ch) => ch.ok);
    const now = Date.now();

    if (allOk) {
      await c.env.DB.prepare(
        `UPDATE outbound_domains SET status = 'verified', last_verified_at = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(now, now, id)
        .run();
      await audit(c.env, {
        actor: `key:${key.key_id}`,
        action: 'outbound_domain.verify',
        target: id,
        meta: { domain: row.domain, checks: checks.map((c2) => c2.name) },
      });
      return c.json({ id, status: 'verified', verified_at: now, checks });
    }

    await audit(c.env, {
      actor: `key:${key.key_id}`,
      action: 'outbound_domain.verify_incomplete',
      target: id,
      meta: {
        domain: row.domain,
        failures: checks.filter((ch) => !ch.ok).map((ch) => ch.name),
      },
    });
    return c.json({
      id,
      status: row.status,
      message: 'verification incomplete',
      checks,
    });
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
