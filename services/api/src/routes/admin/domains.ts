// Admin REST routes for mail_domains (the send/recv domain table).
// All HMAC-signed (admin middleware applied at the parent `admin` Hono instance).
import { Hono } from 'hono';
import {
  CreateMailDomainRequest,
  UpdateMailDomainRequest,
} from '@polaris-email/schema';
import { audit } from '../../audit.js';
import { bodyText, requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';
import { ulid } from '@polaris-email/ids';

export const domains = new Hono<{ Bindings: Env }>();

interface MailDomainRow {
  id: string;
  zone_id: string;
  name: string;
  dkim_selector: string | null;
  status: string;
  cf_zone_id: string | null;
  dmarc_policy: string | null;
  dmarc_rua: string | null;
  verified_at: string | null;
  last_verify_check_at: string | null;
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
}

/**
 * Ensure a `zones` row exists for the given cf_zone_id (or a synthesised
 * placeholder for tests where the operator hasn't pre-provisioned one).
 * Returns the canonical zones.id.
 */
async function ensureZone(
  c: { env: Env },
  cfZoneId: string | null,
  name: string,
): Promise<string> {
  if (cfZoneId) {
    const found = await c.env.DB.prepare(
      `SELECT id FROM zones WHERE cf_zone_id = ?`,
    )
      .bind(cfZoneId)
      .first<{ id: string }>();
    if (found) return found.id;
  }
  const id = ulid();
  const cfId = cfZoneId ?? `local-${id}`;
  await c.env.DB.prepare(
    `INSERT INTO zones (id, cf_zone_id, name, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(id, cfId, name, new Date().toISOString())
    .run();
  return id;
}

// ---------- create ----------
domains.post('/v1/admin/domains', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  let body;
  try {
    body = CreateMailDomainRequest.parse(JSON.parse(bodyText(c)));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  const id = ulid();
  const nowIso = new Date().toISOString();
  const selector = body.dkim_selector ?? 'cf';
  const policy = body.dmarc_policy ?? 'none';
  const rua = body.dmarc_rua ?? `mailto:postmaster@${body.name}`;
  let zoneId: string;
  try {
    zoneId = await ensureZone(c, null, body.name);
  } catch (e) {
    if (String(e).includes('UNIQUE')) return buildError(c, 'conflict', 'domain already registered');
    throw e;
  }
  try {
    await c.env.DB.prepare(
      `INSERT INTO mail_domains
         (id, zone_id, name, environment, status, wildcard_subdomains, dmarc_policy,
          dmarc_rua, inbound_enabled, outbound_enabled, provider, dkim_selector,
          created_at, updated_at)
       VALUES (?, ?, ?, 'prod', 'pending', 1, ?, ?, 0, 1, 'cloudflare', ?, ?, ?)`,
    )
      .bind(id, zoneId, body.name, policy, rua, selector, nowIso, nowIso)
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return buildError(c, 'conflict', 'domain already registered');
    throw e;
  }
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'domain.create',
    target: id,
    meta: { name: body.name, selector },
  });
  return c.json(
    {
      id,
      name: body.name,
      dkim_selector: selector,
      status: 'pending',
      // Convenience hint at the CNAME target the operator can pre-create.
      dkim_cname_hint: `${selector}._domainkey.${body.name}. CNAME ${selector}._domainkey.<zone>.cf-email-routing.com.`,
      created_at: Date.now(),
    },
    201,
  );
});

// ---------- list ----------
domains.get('/v1/admin/domains', requireScope('admin:read'), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, zone_id, name, dkim_selector, status, cf_zone_id, dmarc_policy,
            dmarc_rua, verified_at, last_verify_check_at, created_at, updated_at, disabled_at
     FROM mail_domains ORDER BY name ASC`,
  ).all<MailDomainRow>();
  return c.json({ data: rows.results });
});

// ---------- lookup by name ----------
domains.get('/v1/admin/domains/lookup', requireScope('admin:read'), async (c) => {
  const name = c.req.query('name');
  if (!name) return buildError(c, 'bad_request', 'name required');
  const row = await c.env.DB.prepare(
    `SELECT id, zone_id, name, dkim_selector, status, cf_zone_id, dmarc_policy,
            dmarc_rua, verified_at, last_verify_check_at, created_at, updated_at, disabled_at
     FROM mail_domains WHERE name = ?`,
  )
    .bind(name)
    .first<MailDomainRow>();
  if (!row) return buildError(c, 'not_found', 'mail_domain not found');
  return c.json(row);
});

// ---------- bulk onboard ----------
domains.post('/v1/admin/domains/bulk-onboard', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  let body: { names?: string[] };
  try {
    body = JSON.parse(bodyText(c) || '{}');
  } catch {
    return buildError(c, 'bad_request', 'invalid json');
  }
  if (!Array.isArray(body.names) || body.names.length === 0) {
    return buildError(c, 'bad_request', 'names[] required');
  }
  const results: { name: string; id?: string; error?: string }[] = [];
  const nowIso = new Date().toISOString();
  for (const name of body.names) {
    if (typeof name !== 'string' || name.length < 3 || !name.includes('.')) {
      results.push({ name, error: 'invalid name' });
      continue;
    }
    const id = ulid();
    try {
      const zoneId = await ensureZone(c, null, name);
      await c.env.DB.prepare(
        `INSERT INTO mail_domains
           (id, zone_id, name, environment, status, wildcard_subdomains, dmarc_policy,
            dmarc_rua, inbound_enabled, outbound_enabled, provider, dkim_selector,
            created_at, updated_at)
         VALUES (?, ?, ?, 'prod', 'pending', 1, 'none', ?, 0, 1, 'cloudflare', 'cf', ?, ?)`,
      )
        .bind(id, zoneId, name, `mailto:postmaster@${name}`, nowIso, nowIso)
        .run();
      results.push({ name, id });
      await audit(c.env, {
        actor: `key:${key.key_id}`,
        action: 'domain.create',
        target: id,
        meta: { name, via: 'bulk_onboard' },
      });
    } catch (e) {
      const msg = String(e);
      results.push({ name, error: msg.includes('UNIQUE') ? 'already registered' : msg.slice(0, 200) });
    }
  }
  return c.json({ results });
});

// ---------- rotate DKIM ----------
domains.post('/v1/admin/domains/:id/rotate-dkim', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(`SELECT id, name, dkim_selector FROM mail_domains WHERE id = ?`)
    .bind(id)
    .first<{ id: string; name: string; dkim_selector: string | null }>();
  if (!row) return buildError(c, 'not_found', 'mail_domain not found');
  // Selector rotates by appending a date-stamp suffix. The actual CF API
  // call to publish the new key happens out-of-band (packages/cf-api).
  const current = row.dkim_selector ?? 'cf';
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const next = `${current.replace(/-\d{8}$/, '')}-${stamp}`;
  const nowIso = new Date().toISOString();
  await c.env.DB.prepare(`UPDATE mail_domains SET dkim_selector = ?, updated_at = ? WHERE id = ?`)
    .bind(next, nowIso, id)
    .run();
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'domain.dkim_rotate',
    target: id,
    meta: { name: row.name, prev: current, next },
  });
  return c.json({ id, dkim_selector: next });
});

// ---------- get one ----------
domains.get('/v1/admin/domains/:id', requireScope('admin:read'), async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT id, zone_id, name, dkim_selector, status, cf_zone_id, dmarc_policy,
            dmarc_rua, verified_at, last_verify_check_at, created_at, updated_at, disabled_at
     FROM mail_domains WHERE id = ?`,
  )
    .bind(id)
    .first<MailDomainRow>();
  if (!row) return buildError(c, 'not_found', 'mail_domain not found');
  return c.json(row);
});

// ---------- patch ----------
domains.patch('/v1/admin/domains/:id', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  const id = c.req.param('id');
  let body;
  try {
    body = UpdateMailDomainRequest.parse(JSON.parse(bodyText(c) || '{}'));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  const existing = await c.env.DB.prepare(`SELECT id FROM mail_domains WHERE id = ?`)
    .bind(id)
    .first<{ id: string }>();
  if (!existing) return buildError(c, 'not_found', 'mail_domain not found');

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
  if (body.dkim_selector !== undefined) {
    sets.push('dkim_selector = ?');
    binds.push(body.dkim_selector);
  }
  if (sets.length === 0) return buildError(c, 'bad_request', 'no fields to update');
  const nowIso = new Date().toISOString();
  sets.push('updated_at = ?');
  binds.push(nowIso);
  binds.push(id);
  await c.env.DB.prepare(
    `UPDATE mail_domains SET ${sets.join(', ')} WHERE id = ?`,
  )
    .bind(...binds)
    .run();
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'domain.update',
    target: id,
    meta: { fields: Object.keys(body) },
  });
  return c.json({ id, updated_at: Date.now() });
});

// ---------- verify (real DNS check via DoH + CF Email Routing) ----------
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

const DNS_CNAME = 5;
const DNS_MX = 15;

async function dohResolve(host: string, type: 'CNAME' | 'MX'): Promise<DohAnswer[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) return [];
  const j = (await res.json()) as DohResponse;
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

domains.post('/v1/admin/domains/:id/verify', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT id, name, status, cf_zone_id FROM mail_domains WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: string; name: string; status: string; cf_zone_id: string | null }>();
  if (!row) return buildError(c, 'not_found', 'mail_domain not found');

  const env = c.env as unknown as { CF_API_TOKEN?: string; CF_ACCOUNT_ID?: string };
  const apiToken = env.CF_API_TOKEN;
  const accountId = env.CF_ACCOUNT_ID;

  const checks: VerifyCheck[] = [];

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
      action: 'domain.verify_incomplete',
      target: id,
      meta: { name: row.name, reason: 'no-cf-creds' },
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

  const mxAnswers = await dohResolve(row.name, 'MX').catch(() => []);
  const seenMxHosts = mxAnswers
    .map((a) => stripDot(a.data.split(/\s+/).pop() ?? '').toLowerCase())
    .filter((h) => h.length > 0);
  const expectedMxHosts = expected
    .filter((r) => r.type.toUpperCase() === 'MX')
    .map((r) => stripDot(r.content).toLowerCase());
  const fallbackMx = [
    'route1.mx.cloudflare.net',
    'route2.mx.cloudflare.net',
    'route3.mx.cloudflare.net',
  ];
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
  const nowIso = new Date().toISOString();

  if (allOk) {
    await c.env.DB.prepare(
      `UPDATE mail_domains SET status = 'verified', verified_at = ?, last_verify_check_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(nowIso, nowIso, nowIso, id)
      .run();
    await audit(c.env, {
      actor: `key:${key.key_id}`,
      action: 'domain.verify',
      target: id,
      meta: { name: row.name, checks: checks.map((c2) => c2.name) },
    });
    return c.json({ id, status: 'verified', verified_at: Date.now(), checks });
  }

  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'domain.verify_incomplete',
    target: id,
    meta: {
      name: row.name,
      failures: checks.filter((ch) => !ch.ok).map((ch) => ch.name),
    },
  });
  return c.json({
    id,
    status: row.status,
    message: 'verification incomplete',
    checks,
  });
});

// ---------- soft-disable ----------
domains.delete('/v1/admin/domains/:id', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  const id = c.req.param('id');
  const nowIso = new Date().toISOString();
  const r = await c.env.DB.prepare(
    `UPDATE mail_domains
     SET status = 'disabled', disabled_at = ?, updated_at = ?
     WHERE id = ? AND disabled_at IS NULL`,
  )
    .bind(nowIso, nowIso, id)
    .run();
  if (r.meta.changes === 0) return buildError(c, 'not_found', 'not found or already disabled');
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'domain.disable',
    target: id,
    meta: {},
  });
  return c.json({ id, disabled_at: Date.now() });
});
