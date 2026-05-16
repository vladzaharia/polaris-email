// Admin REST routes for mail_domains (the send/recv domain table).
// All HMAC-signed (admin middleware applied at the parent `admin` Hono instance).
import { Hono } from 'hono';
import { CreateMailDomainRequest, UpdateMailDomainRequest } from '@polaris-email/schema';
import { generatePolicyId, verifyMtaSts, verifyTlsRpt } from '@polaris-email/cf-api';
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
 * W2 — Well-known ID of the platform-owned complaints mailbox.
 * Seeded by migration 0011_complaint_routing.sql.
 */
const PLATFORM_COMPLAINTS_MAILBOX_ID = '01HXPLATFORMCOMPLAINTS0000';

/** W2 — RFC 2142 receivers we auto-provision on every domain.
 *  Patterns are full address-with-wildcard so the services/in matcher
 *  (which compares against envelope-to) matches `postmaster@anydomain.tld`. */
const COMPLAINT_RECEIVER_PATTERNS = ['postmaster@*', 'abuse@*', 'webmaster@*'] as const;

/**
 * W2 — Ensure the three RFC 2142 complaint receivers exist for a domain.
 * Each receiver routes to the platform-owned complaints mailbox. Idempotent:
 * skips patterns that already have a row.
 *
 * Action='webhook' is used as a sentinel here; the inbound handler in
 * services/in special-cases the platform mailbox and dispatches into the
 * W2 ARF/DSN parser instead of fanning out to webhook subscribers.
 */
async function ensureComplaintReceivers(env: Env, domainId: string): Promise<void> {
  const existing = await env.DB.prepare(
    `SELECT address_pattern FROM mailbox_receivers WHERE domain_id = ? AND mailbox_id = ?`,
  )
    .bind(domainId, PLATFORM_COMPLAINTS_MAILBOX_ID)
    .all<{ address_pattern: string }>();
  const have = new Set((existing.results ?? []).map((r) => r.address_pattern));
  const now = new Date().toISOString();
  const stmts = [];
  for (const pattern of COMPLAINT_RECEIVER_PATTERNS) {
    if (have.has(pattern)) continue;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO mailbox_receivers
           (id, mailbox_id, domain_id, priority, address_pattern, action,
            webhook_sub_id, forward_to, enabled, created_at, disabled_at)
         VALUES (?, ?, ?, 10, ?, 'webhook', NULL, NULL, 1, ?, NULL)`,
      ).bind(ulid(), PLATFORM_COMPLAINTS_MAILBOX_ID, domainId, pattern, now),
    );
  }
  if (stmts.length > 0) {
    await env.DB.batch(stmts);
  }
}

/**
 * Ensure a `zones` row exists for the given cf_zone_id (or a synthesised
 * placeholder for tests where the operator hasn't pre-provisioned one).
 * Returns the canonical zones.id.
 */
async function ensureZone(c: { env: Env }, cfZoneId: string | null, name: string): Promise<string> {
  if (cfZoneId) {
    const found = await c.env.DB.prepare(`SELECT id FROM zones WHERE cf_zone_id = ?`)
      .bind(cfZoneId)
      .first<{ id: string }>();
    if (found) return found.id;
  }
  const id = ulid();
  const cfId = cfZoneId ?? `local-${id}`;
  await c.env.DB.prepare(`INSERT INTO zones (id, cf_zone_id, name, created_at) VALUES (?, ?, ?, ?)`)
    .bind(id, cfId, name, new Date().toISOString())
    .run();
  return id;
}

// ---------- create ----------
//
// MTA-STS / TLS-RPT defaults (Phase C.11):
//
// We persist the *intent* to run MTA-STS in testing mode and TLS-RPT to the
// configured aggregation address on every fresh domain row, but this does NOT
// touch DNS. Unlike DKIM / SPF / DMARC — which Cloudflare auto-publishes when
// Email Routing onboards the zone — MTA-STS records (the `_mta-sts.{domain}`
// TXT plus the `mta-sts.{domain}` Worker custom domain) require an explicit
// operator action via `POST /v1/admin/domains/:id/mta-sts/enable`.
//
// The verify endpoint (Phase C.12) compares this stored intent against what's
// actually published and surfaces an operator-action hint when they diverge,
// pointing the operator at the lifecycle endpoint they need to call.
//
// Operators who want to opt out at create time can PATCH `mta_sts_mode='none'`
// and `tlsrpt_enabled=false` immediately afterwards, or simply never call
// /mta-sts/enable — the intent column has no on-disk side effects until that
// happens.
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
  // W6 — DMARC RUA default. Adds the platform aggregator alongside the
  // postmaster mailbox so reports land where W6's parser can rollup them
  // even if the operator hasn't wired their own postmaster routing. DMARC
  // allows multiple URIs (comma-separated, RFC 7489 §6.3).
  const platformDmarcRua = c.env.DMARC_RUA_PLATFORM_ALIAS ?? 'mailto:dmarc-rua@plrs.im';
  const rua = body.dmarc_rua ?? `mailto:postmaster@${body.name},${platformDmarcRua}`;
  // MTA-STS / TLS-RPT intent defaults — see comment block above.
  const mtaStsMode = 'testing';
  const mtaStsPolicyId = generatePolicyId();
  const mtaStsMaxAge = 86_400;
  const tlsrptEnabled = 1;
  const tlsrptRua = c.env.TLSRPT_DEFAULT_RUA ?? 'mailto:tlsrpt@plrs.im';
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
         (id, zone_id, name, status, wildcard_subdomains, dmarc_policy,
          dmarc_rua, inbound_enabled, outbound_enabled, provider, dkim_selector,
          mta_sts_mode, mta_sts_policy_id, mta_sts_max_age,
          tlsrpt_enabled, tlsrpt_rua,
          created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 1, ?, ?, 0, 1, 'cloudflare', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        zoneId,
        body.name,
        policy,
        rua,
        selector,
        mtaStsMode,
        mtaStsPolicyId,
        mtaStsMaxAge,
        tlsrptEnabled,
        tlsrptRua,
        nowIso,
        nowIso,
      )
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return buildError(c, 'conflict', 'domain already registered');
    throw e;
  }
  // W2 — auto-provision RFC 2142 complaint receivers (postmaster, abuse,
  // webmaster). All three point at the platform `polaris-platform-complaints`
  // mailbox so inbound mail to them lands in one place for ARF/DSN parsing.
  // Idempotent: receivers are skipped if already present (e.g. the backfill
  // script created them before the operator re-onboarded the domain).
  try {
    await ensureComplaintReceivers(c.env, id);
  } catch (e) {
    // Don't fail the domain create if the receivers can't be provisioned;
    // the backfill script can pick them up later. Just log.
    // eslint-disable-next-line no-console
    console.warn('domain.create: failed to provision complaint receivers', e);
  }
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'domain.create',
    target: id,
    meta: {
      name: body.name,
      selector,
      mta_sts_mode: mtaStsMode,
      mta_sts_policy_id: mtaStsPolicyId,
      tlsrpt_enabled: tlsrptEnabled,
      complaint_receivers: 'auto_provisioned',
    },
  });
  return c.json(
    {
      id,
      name: body.name,
      dkim_selector: selector,
      status: 'pending',
      mta_sts_mode: mtaStsMode,
      mta_sts_policy_id: mtaStsPolicyId,
      mta_sts_max_age: mtaStsMaxAge,
      tlsrpt_enabled: tlsrptEnabled,
      tlsrpt_rua: tlsrptRua,
      // Convenience hint at the CNAME target the operator can pre-create.
      dkim_cname_hint: `${selector}._domainkey.${body.name}. CNAME ${selector}._domainkey.<zone>.cf-email-routing.com.`,
      // Intent columns are persisted, but DNS records require an explicit
      // POST /v1/admin/domains/:id/mta-sts/enable call to be published.
      mta_sts_provisioning_hint: `MTA-STS intent recorded. Call POST /v1/admin/domains/${id}/mta-sts/enable to publish DNS records.`,
      tlsrpt_provisioning_hint: `TLS-RPT intent recorded. Call POST /v1/admin/domains/${id}/tls-rpt/enable to publish DNS records.`,
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
  // Same MTA-STS / TLS-RPT intent defaults as the single-create handler
  // (Phase C.11). Each row gets its own minted policy_id so bumping one
  // tenant doesn't bust caches across the entire bulk-onboarded batch.
  const tlsrptRuaDefault = c.env.TLSRPT_DEFAULT_RUA ?? 'mailto:tlsrpt@plrs.im';
  for (const name of body.names) {
    if (typeof name !== 'string' || name.length < 3 || !name.includes('.')) {
      results.push({ name, error: 'invalid name' });
      continue;
    }
    const id = ulid();
    const mtaStsPolicyId = generatePolicyId();
    try {
      const zoneId = await ensureZone(c, null, name);
      await c.env.DB.prepare(
        `INSERT INTO mail_domains
           (id, zone_id, name, status, wildcard_subdomains, dmarc_policy,
            dmarc_rua, inbound_enabled, outbound_enabled, provider, dkim_selector,
            mta_sts_mode, mta_sts_policy_id, mta_sts_max_age,
            tlsrpt_enabled, tlsrpt_rua,
            created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 1, 'none', ?, 0, 1, 'cloudflare', 'cf',
                 'testing', ?, 86400, 1, ?, ?, ?)`,
      )
        .bind(
          id,
          zoneId,
          name,
          `mailto:postmaster@${name}`,
          mtaStsPolicyId,
          tlsrptRuaDefault,
          nowIso,
          nowIso,
        )
        .run();
      // W2 — auto-provision RFC 2142 complaint receivers for this domain too.
      try {
        await ensureComplaintReceivers(c.env, id);
      } catch {
        // tolerated, same as single create path
      }
      results.push({ name, id });
      await audit(c.env, {
        actor: `key:${key.key_id}`,
        action: 'domain.create',
        target: id,
        meta: {
          name,
          via: 'bulk_onboard',
          mta_sts_mode: 'testing',
          mta_sts_policy_id: mtaStsPolicyId,
          tlsrpt_enabled: 1,
          complaint_receivers: 'auto_provisioned',
        },
      });
    } catch (e) {
      const msg = String(e);
      results.push({
        name,
        error: msg.includes('UNIQUE') ? 'already registered' : msg.slice(0, 200),
      });
    }
  }
  return c.json({ results });
});

// ---------- rotate DKIM ----------
domains.post('/v1/admin/domains/:id/rotate-dkim', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT id, name, dkim_selector FROM mail_domains WHERE id = ?`,
  )
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
  await c.env.DB.prepare(`UPDATE mail_domains SET ${sets.join(', ')} WHERE id = ?`)
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

interface VerifyDomainRow {
  id: string;
  name: string;
  status: string;
  cf_zone_id: string | null;
  mta_sts_mode: string;
  mta_sts_policy_id: string | null;
  tlsrpt_enabled: number;
  tlsrpt_rua: string | null;
}

domains.post('/v1/admin/domains/:id/verify', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT id, name, status, cf_zone_id,
            mta_sts_mode, mta_sts_policy_id, tlsrpt_enabled, tlsrpt_rua
     FROM mail_domains WHERE id = ?`,
  )
    .bind(id)
    .first<VerifyDomainRow>();
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
  expected = await fetchExpectedRoutingDns(accountId!, row.cf_zone_id!, apiToken!).catch(() => []);

  for (const rec of expected.filter((r) => r.type.toUpperCase() === 'CNAME')) {
    const want = stripDot(rec.content).toLowerCase();
    const got = await dohResolve(rec.name, 'CNAME').catch((e: unknown) => {
      // eslint-disable-next-line no-console
      console.warn(
        `dohResolve CNAME ${rec.name} failed`,
        e instanceof Error ? e.message : 'unknown',
      );
      return [];
    });
    const seen = got.map((a) => stripDot(a.data).toLowerCase());
    checks.push({
      name: `cname:${rec.name}`,
      ok: seen.includes(want),
      expected: want,
      actual: seen.join(',') || '(empty)',
    });
  }

  const mxAnswers = await dohResolve(row.name, 'MX').catch((e: unknown) => {
    // eslint-disable-next-line no-console
    console.warn(`dohResolve MX ${row.name} failed`, e instanceof Error ? e.message : 'unknown');
    return [];
  });
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
  const mxOk = wantMxSet.length > 0 && wantMxSet.every((h) => haveMxSet.includes(h));
  checks.push({
    name: 'mx',
    ok: mxOk,
    expected: wantMxSet.join(','),
    actual: haveMxSet.join(',') || '(empty)',
  });

  // ---------- MTA-STS sub-block (Phase C.12) ----------
  //
  // Only runs when intent is non-`none`. The verifier calls DoH for the TXT
  // and HTTPS for the policy file; we surface its raw checks AND append an
  // operator-action hint when any check fails, since these records require
  // an explicit `POST /v1/admin/domains/:id/mta-sts/enable` to (re-)publish.
  //
  // Three distinct failure flavours all collapse to the same hint:
  //   - Never provisioned: TXT NXDOMAIN, mta-sts.{tenant} not reachable.
  //   - Drifted: TXT present but its id differs from `mta_sts_policy_id`
  //     (e.g. after a /promote that bumped the column but DNS hasn't been
  //     re-published yet).
  //   - Worker custom domain unreachable: HTTPS GET returns non-200 or a
  //     non-`text/plain` content-type.
  //
  // In all three cases the fix is the same: re-run the /mta-sts/enable
  // endpoint, which is idempotent.
  let mtaStsRanAndAllPassed = false;
  if (row.mta_sts_mode !== 'none') {
    const mtaSts = await verifyMtaSts(row.name, row.mta_sts_policy_id);
    checks.push(...mtaSts.checks);
    const someFailed = mtaSts.checks.some((ch) => !ch.ok);
    if (someFailed) {
      checks.push({
        name: `mta-sts:operator-action:${row.name}`,
        ok: false,
        expected: `mode=${row.mta_sts_mode}, policy_id=${row.mta_sts_policy_id ?? '(unset)'}`,
        actual: `MTA-STS records require manual re-provisioning. Call POST /v1/admin/domains/${row.id}/mta-sts/enable to publish.`,
      });
    } else {
      mtaStsRanAndAllPassed = true;
    }
  }

  // ---------- TLS-RPT sub-block (Phase C.12) ----------
  let tlsRptRanAndAllPassed = false;
  if (row.tlsrpt_enabled === 1) {
    const tlsrpt = await verifyTlsRpt(row.name, row.tlsrpt_rua ?? null);
    checks.push(...tlsrpt.checks);
    const someFailed = tlsrpt.checks.some((ch) => !ch.ok);
    if (someFailed) {
      checks.push({
        name: `tls-rpt:operator-action:${row.name}`,
        ok: false,
        expected: `rua=${row.tlsrpt_rua ?? '(unset)'}`,
        actual: `TLS-RPT records require manual re-provisioning. Call POST /v1/admin/domains/${row.id}/tls-rpt/enable to publish.`,
      });
    } else {
      tlsRptRanAndAllPassed = true;
    }
  }

  const allOk = checks.length > 0 && checks.every((ch) => ch.ok);
  const nowIso = new Date().toISOString();

  // Persist sub-block `*_verified_at` timestamps independently of the
  // overall verify outcome. This lets the operator see "TLS-RPT verified
  // 2026-05-15" even when an unrelated MX glitch makes overall verify fail.
  const subUpdates: string[] = [];
  const subBinds: unknown[] = [];
  if (mtaStsRanAndAllPassed) {
    subUpdates.push('mta_sts_verified_at = ?');
    subBinds.push(nowIso);
  }
  if (tlsRptRanAndAllPassed) {
    subUpdates.push('tlsrpt_verified_at = ?');
    subBinds.push(nowIso);
  }

  if (allOk) {
    const fullSet = ['status = ?', 'verified_at = ?', 'last_verify_check_at = ?', 'updated_at = ?'];
    const fullBinds: unknown[] = ['verified', nowIso, nowIso, nowIso];
    if (subUpdates.length) {
      fullSet.push(...subUpdates);
      fullBinds.push(...subBinds);
    }
    fullBinds.push(id);
    await c.env.DB.prepare(`UPDATE mail_domains SET ${fullSet.join(', ')} WHERE id = ?`)
      .bind(...fullBinds)
      .run();
    await audit(c.env, {
      actor: `key:${key.key_id}`,
      action: 'domain.verify',
      target: id,
      meta: { name: row.name, checks: checks.map((c2) => c2.name) },
    });
    return c.json({ id, status: 'verified', verified_at: Date.now(), checks });
  }

  // Even when overall verify failed, persist any sub-block that did pass so
  // the panel can render a partial-green status. The main `verified_at` and
  // `status='verified'` only flip when ALL checks pass (existing semantics).
  if (subUpdates.length) {
    await c.env.DB.prepare(
      `UPDATE mail_domains SET ${subUpdates.join(', ')}, updated_at = ? WHERE id = ?`,
    )
      .bind(...subBinds, nowIso, id)
      .run();
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

// ---------- enable/disable inbound/outbound ----------
//
// Four near-identical endpoints; the matrix is bounded so we register them
// explicitly rather than collapsing via a helper that loses Hono's per-route
// context typing.
type FlagSpec = {
  readonly path: `/v1/admin/domains/:id/${'inbound' | 'outbound'}/${'enable' | 'disable'}`;
  readonly column: 'inbound_enabled' | 'outbound_enabled';
  readonly enabled: boolean;
  readonly action:
    | 'domain.inbound.enable'
    | 'domain.inbound.disable'
    | 'domain.outbound.enable'
    | 'domain.outbound.disable';
};

const TOGGLES: readonly FlagSpec[] = [
  {
    path: '/v1/admin/domains/:id/inbound/enable',
    column: 'inbound_enabled',
    enabled: true,
    action: 'domain.inbound.enable',
  },
  {
    path: '/v1/admin/domains/:id/inbound/disable',
    column: 'inbound_enabled',
    enabled: false,
    action: 'domain.inbound.disable',
  },
  {
    path: '/v1/admin/domains/:id/outbound/enable',
    column: 'outbound_enabled',
    enabled: true,
    action: 'domain.outbound.enable',
  },
  {
    path: '/v1/admin/domains/:id/outbound/disable',
    column: 'outbound_enabled',
    enabled: false,
    action: 'domain.outbound.disable',
  },
];

for (const spec of TOGGLES) {
  domains.post(spec.path, requireScope('admin:rotate'), async (c) => {
    const key = c.get('apiKey');
    const id = c.req.param('id');
    const row = await c.env.DB.prepare(`SELECT id, name FROM mail_domains WHERE id = ?`)
      .bind(id)
      .first<{ id: string; name: string }>();
    if (!row) return buildError(c, 'not_found', 'mail_domain not found');
    const nowIso = new Date().toISOString();
    await c.env.DB.prepare(
      `UPDATE mail_domains SET ${spec.column} = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(spec.enabled ? 1 : 0, nowIso, id)
      .run();
    await audit(c.env, {
      actor: `key:${key.key_id}`,
      action: spec.action,
      target: id,
      meta: { name: row.name },
    });
    return c.json({ id, [spec.column]: spec.enabled });
  });
}

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
