// Admin REST routes for mail_domains (the send/recv domain table).
// All HMAC-signed (admin middleware applied at the parent `admin` Hono instance).
import { Hono } from 'hono';
import { CreateMailDomainRequest, UpdateMailDomainRequest } from '@polaris-mail/schema';
import { CloudflareApiClient, findZoneByName, generatePolicyId } from '@polaris-mail/cf-api';
import { actorOf, audit } from '../../audit.js';
import { bodyText, requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';
import { ulid } from '@polaris-mail/ids';
import { verifyDomain } from '../../lib/verify-domain.js';

/**
 * Resolve a Cloudflare zone id for the given mail-domain name.
 *
 * Used at create time so `mail_domains.cf_zone_id` lands populated and
 * the `cf-email-routing-dns` verify check can fire without a manual
 * follow-up PATCH. Reuses {@link findZoneByName} which walks up DNS
 * labels — `mail.acme.example` matches the `acme.example` zone, falling
 * back to `example` if that's all the operator has.
 *
 * Returns `null` (never throws) when either CF credential is missing or
 * the CF API call errors — the create handler tolerates a null result
 * and lets the verify check report the gap clearly.
 */
async function resolveCfZoneId(env: Env, domainName: string): Promise<string | null> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return null;
  try {
    const client = new CloudflareApiClient({
      apiToken: env.CF_API_TOKEN,
      accountId: env.CF_ACCOUNT_ID,
    });
    const zone = await findZoneByName(client, domainName);
    return zone?.id ?? null;
  } catch {
    return null;
  }
}

export const domains = new Hono<{ Bindings: Env }>();

interface MailDomainRow {
  id: string;
  zone_id: string;
  name: string;
  dkim_selector: string | null;
  status: string;
  cf_zone_id: string | null;
  dmarc_policy: string | null;
  verified_at: string | null;
  last_verify_check_at: string | null;
  inbound_enabled: number;
  outbound_enabled: number;
  // MTA-STS + TLS-RPT projection. These were previously dropped on the
  // floor by the GET / list / lookup handlers, so the panel rendered
  // `mta_sts_mode: 'none'` and `tlsrpt_enabled: 0` even after the
  // operator called the enable endpoints (which DO write the columns).
  mta_sts_mode: string;
  mta_sts_policy_id: string | null;
  mta_sts_max_age: number | null;
  mta_sts_verified_at: string | null;
  tlsrpt_enabled: number;
  tlsrpt_rua: string | null;
  tlsrpt_verified_at: string | null;
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
}

// Shared column list for the three read endpoints (list, lookup, get-by-id).
// Centralising prevents the recurrence of the bug where one SELECT projected
// a different subset than the others.
const MAIL_DOMAIN_READ_COLS = `id, zone_id, name, dkim_selector, status, cf_zone_id,
       dmarc_policy, verified_at, last_verify_check_at,
       inbound_enabled, outbound_enabled,
       mta_sts_mode, mta_sts_policy_id, mta_sts_max_age, mta_sts_verified_at,
       tlsrpt_enabled, tlsrpt_rua, tlsrpt_verified_at,
       created_at, updated_at, disabled_at`;

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
// MTA-STS / TLS-RPT defaults:
//
// We persist the *intent* to run MTA-STS in testing mode and TLS-RPT to the
// configured aggregation address on every fresh domain row, but this does NOT
// touch DNS. Unlike DKIM / SPF / DMARC — which Cloudflare auto-publishes when
// Email Routing onboards the zone — MTA-STS records (the `_mta-sts.{domain}`
// TXT plus the `mta-sts.{domain}` Worker custom domain) require an explicit
// operator action via `POST /v1/admin/domains/:id/mta-sts/enable`.
//
// The verify endpoint compares this stored intent against what's
// actually published and surfaces an operator-action hint when they diverge,
// pointing the operator at the lifecycle endpoint they need to call.
//
// Operators who want to opt out at create time can PATCH `mta_sts_mode='none'`
// and `tlsrpt_enabled=false` immediately afterwards, or simply never call
// /mta-sts/enable — the intent column has no on-disk side effects until that
// happens.
domains.post('/v1/admin/domains', requireScope('admin:rotate'), async (c) => {
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
  // MTA-STS / TLS-RPT intent defaults — see comment block above.
  const mtaStsMode = 'testing';
  const mtaStsPolicyId = generatePolicyId();
  const mtaStsMaxAge = 86_400;
  const tlsrptEnabled = 1;
  const tlsrptRua = c.env.TLSRPT_DEFAULT_RUA ?? 'mailto:tlsrpt@plrs.im';
  // Resolve the CF zone id: caller-supplied wins (panel passes the id
  // from its dropdown), otherwise we look it up via CF's /zones API.
  // The verify endpoint's `cf-email-routing-dns` check requires this
  // to be populated; null is tolerated (verify reports it clearly) so a
  // CF outage / missing-secret doesn't block a domain create.
  const cfZoneId: string | null = body.cf_zone_id ?? (await resolveCfZoneId(c.env, body.name));
  let zoneId: string;
  try {
    zoneId = await ensureZone(c, cfZoneId, body.name);
  } catch (e) {
    if (String(e).includes('UNIQUE')) return buildError(c, 'conflict', 'domain already registered');
    throw e;
  }
  try {
    await c.env.DB.prepare(
      `INSERT INTO mail_domains
         (id, zone_id, name, status, wildcard_subdomains, cf_zone_id, dmarc_policy,
          inbound_enabled, outbound_enabled, provider, dkim_selector,
          mta_sts_mode, mta_sts_policy_id, mta_sts_max_age,
          tlsrpt_enabled, tlsrpt_rua,
          created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 1, ?, ?, 0, 1, 'cloudflare', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        zoneId,
        body.name,
        cfZoneId,
        policy,
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
    actor: actorOf(c),
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
    `SELECT ${MAIL_DOMAIN_READ_COLS} FROM mail_domains ORDER BY name ASC`,
  ).all<MailDomainRow>();
  return c.json({ data: rows.results });
});

// ---------- lookup by name ----------
domains.get('/v1/admin/domains/lookup', requireScope('admin:read'), async (c) => {
  const name = c.req.query('name');
  if (!name) return buildError(c, 'bad_request', 'name required');
  const row = await c.env.DB.prepare(
    `SELECT ${MAIL_DOMAIN_READ_COLS} FROM mail_domains WHERE name = ?`,
  )
    .bind(name)
    .first<MailDomainRow>();
  if (!row) return buildError(c, 'not_found', 'mail_domain not found');
  return c.json(row);
});

// ---------- bulk onboard ----------
domains.post('/v1/admin/domains/bulk-onboard', requireScope('admin:rotate'), async (c) => {
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
  //. Each row gets its own minted policy_id so bumping one
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
      // Bulk onboard doesn't accept per-row cf_zone_id in the request
      // body, so always auto-resolve via CF's /zones API. Same null-
      // tolerant semantics as the single-create path.
      const cfZoneId = await resolveCfZoneId(c.env, name);
      const zoneId = await ensureZone(c, cfZoneId, name);
      await c.env.DB.prepare(
        `INSERT INTO mail_domains
           (id, zone_id, name, status, wildcard_subdomains, cf_zone_id, dmarc_policy,
            inbound_enabled, outbound_enabled, provider, dkim_selector,
            mta_sts_mode, mta_sts_policy_id, mta_sts_max_age,
            tlsrpt_enabled, tlsrpt_rua,
            created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 1, ?, 'none', 0, 1, 'cloudflare', 'cf',
                 'testing', ?, 86400, 1, ?, ?, ?)`,
      )
        .bind(id, zoneId, name, cfZoneId, mtaStsPolicyId, tlsrptRuaDefault, nowIso, nowIso)
        .run();
      // W2 — auto-provision RFC 2142 complaint receivers for this domain too.
      try {
        await ensureComplaintReceivers(c.env, id);
      } catch {
        // tolerated, same as single create path
      }
      results.push({ name, id });
      await audit(c.env, {
        actor: actorOf(c),
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
    actor: actorOf(c),
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
    `SELECT ${MAIL_DOMAIN_READ_COLS} FROM mail_domains WHERE id = ?`,
  )
    .bind(id)
    .first<MailDomainRow>();
  if (!row) return buildError(c, 'not_found', 'mail_domain not found');
  return c.json(row);
});

// ---------- list receivers under a domain ----------
// Feeds the Routes tab on the domain detail page. Joins with `mailboxes`
// so the panel can render the owning mailbox's display name without an
// extra round-trip per row. `disabled_at IS NULL` matches the runtime
// resolver in `services/in/src/index.ts` so the operator sees the same
// set of routes that are actually live.
domains.get('/v1/admin/domains/:id/receivers', requireScope('admin:read'), async (c) => {
  const id = c.req.param('id');
  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.mailbox_id, r.domain_id, r.priority, r.address_pattern,
            r.action, r.webhook_sub_id, r.forward_to, r.enabled,
            r.created_at, r.disabled_at,
            m.name AS mailbox_name
       FROM mailbox_receivers r
       JOIN mailboxes m ON m.id = r.mailbox_id
      WHERE r.domain_id = ? AND r.disabled_at IS NULL
      ORDER BY r.priority ASC, r.created_at ASC`,
  )
    .bind(id)
    .all<{
      id: string;
      mailbox_id: string;
      domain_id: string;
      priority: number;
      address_pattern: string;
      action: 'webhook' | 'forward' | 'drop';
      webhook_sub_id: string | null;
      forward_to: string | null;
      enabled: number;
      created_at: string;
      disabled_at: string | null;
      mailbox_name: string;
    }>();
  return c.json({ data: rows.results });
});

// ---------- domain-scoped audit log ----------
// Returns rows from `audit_log` where `target` matches this domain's id.
// The mutation handlers in this file already write `target: id`, so a
// straight equality filter is enough. Cross-references in `meta` (e.g.
// mailbox CRUD that happens to mention this domain) are intentionally
// excluded — those belong on the relevant mailbox page.
domains.get('/v1/admin/domains/:id/audit', requireScope('admin:read'), async (c) => {
  const id = c.req.param('id');
  const limitRaw = Number.parseInt(c.req.query('limit') ?? '25', 10);
  const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 25));
  const beforeId = Number.parseInt(c.req.query('before_id') ?? '0', 10);
  let rows;
  if (beforeId > 0) {
    rows = await c.env.DB.prepare(
      `SELECT id, actor, action, target, at, prev_hash, row_hash, meta
         FROM audit_log
        WHERE target = ? AND id < ?
        ORDER BY id DESC LIMIT ?`,
    )
      .bind(id, beforeId, limit)
      .all();
  } else {
    rows = await c.env.DB.prepare(
      `SELECT id, actor, action, target, at, prev_hash, row_hash, meta
         FROM audit_log
        WHERE target = ?
        ORDER BY id DESC LIMIT ?`,
    )
      .bind(id, limit)
      .all();
  }
  return c.json({ data: rows.results });
});

// ---------- patch ----------
domains.patch('/v1/admin/domains/:id', requireScope('admin:rotate'), async (c) => {
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
    actor: actorOf(c),
    action: 'domain.update',
    target: id,
    meta: { fields: Object.keys(body) },
  });
  return c.json({ id, updated_at: Date.now() });
});

// ---------- verify (real DNS check via DoH + CF Email Routing) ----------
//
// The full verify flow lives in `services/api/src/lib/verify-domain.ts`
// — shared with the hourly background cron in
// `services/api/src/scheduled/domain-verify.ts`. This route is a thin
// wrapper that translates the verifyDomain() outcome into HTTP.
domains.post('/v1/admin/domains/:id/verify', requireScope('admin:rotate'), async (c) => {
  const id = c.req.param('id');
  const { outcome, response } = await verifyDomain(c.env, id, actorOf(c));
  if (outcome === 'not_found') return buildError(c, 'not_found', 'mail_domain not found');
  return c.json(response);
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
      actor: actorOf(c),
      action: spec.action,
      target: id,
      meta: { name: row.name },
    });
    return c.json({ id, [spec.column]: spec.enabled });
  });
}

// ---------- soft-disable ----------
domains.delete('/v1/admin/domains/:id', requireScope('admin:rotate'), async (c) => {
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
    actor: actorOf(c),
    action: 'domain.disable',
    target: id,
    meta: {},
  });
  return c.json({ id, disabled_at: Date.now() });
});
