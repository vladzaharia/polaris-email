// Admin REST routes for MTA-STS + TLS-RPT lifecycle.
//
// Five POST endpoints, all `admin:rotate`-scoped and HMAC-authed via the
// parent `admin` Hono instance:
//
//   - POST /v1/admin/domains/:id/mta-sts/enable
//   - POST /v1/admin/domains/:id/mta-sts/disable
//   - POST /v1/admin/domains/:id/mta-sts/promote
//   - POST /v1/admin/domains/:id/tls-rpt/enable
//   - POST /v1/admin/domains/:id/tls-rpt/disable
//
// Each endpoint orchestrates the Cloudflare side (DNS TXT + Worker custom
// domain for MTA-STS, TXT only for TLS-RPT) via `packages/cf-api`, then
// reconciles the `mail_domains` row and emits an audit event. Caller
// returns are intentionally narrow so we can extend them later without a
// schema break.
//
// Preconditions enforced at every entry:
//   1. Domain row exists.
//   2. Status === 'verified' (Cloudflare cannot publish a policy on an
//      unverified zone).
//   3. `inbound_enabled = 1` — MTA-STS protects *receiving* mail; toggling
//      it on a send-only domain would be meaningless and burns a Worker
//      custom domain slot.
//   4. `cf_zone_id` is populated (cached by the verify endpoint).
//   5. `CF_API_TOKEN` + `CF_ACCOUNT_ID` are present in env.
//
// Failure of (1) → 404 not_found; (2)/(3) → 422 domain_not_verified;
// (4) → 400 bad_request; (5) → 502 cf_upstream.
import { Hono, type Context } from 'hono';
import {
  CloudflareApiClient,
  generatePolicyId,
  provisionMtaSts,
  provisionTlsRpt,
  unprovisionMtaSts,
  unprovisionTlsRpt,
} from '@polaris-email/cf-api';
import { audit } from '../../audit.js';
import { bodyText, requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const domainsMtaSts = new Hono<{ Bindings: Env }>();

/** Worker script name — must match services/api/wrangler.jsonc `name`. */
const WORKER_NAME = 'polaris-email-api';

interface DomainRow {
  id: string;
  name: string;
  cf_zone_id: string | null;
  mta_sts_mode: string;
  mta_sts_policy_id: string | null;
  tlsrpt_enabled: number;
  tlsrpt_rua: string | null;
  inbound_enabled: number;
  status: string;
}

/**
 * Build a `CloudflareApiClient` from env-injected secrets. Returns null when
 * the required pair is missing so callers can return a typed 502.
 *
 * The `fetchImpl` is left to the client default (`globalThis.fetch`); tests
 * that need to intercept upstream calls patch the global directly — see
 * `services/api/test/integration/mta-sts-admin.workers.test.ts`.
 */
function makeCfClient(env: Env): CloudflareApiClient | null {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return null;
  return new CloudflareApiClient({
    apiToken: env.CF_API_TOKEN,
    accountId: env.CF_ACCOUNT_ID,
  });
}

async function loadDomain(env: Env, id: string): Promise<DomainRow | null> {
  return env.DB.prepare(
    `SELECT id, name, cf_zone_id, mta_sts_mode, mta_sts_policy_id,
            tlsrpt_enabled, tlsrpt_rua, inbound_enabled, status
     FROM mail_domains
     WHERE id = ? AND disabled_at IS NULL`,
  )
    .bind(id)
    .first<DomainRow>();
}

/** Common preflight: existence + verified + inbound + cf_zone_id checks. */
type Preflight =
  | { ok: true; row: DomainRow; client: CloudflareApiClient }
  | { ok: false; response: Response };

function preflight(c: Context<{ Bindings: Env }>, row: DomainRow | null): Preflight {
  if (!row) {
    return { ok: false, response: buildError(c, 'not_found', 'mail_domain not found') };
  }
  if (row.status !== 'verified') {
    return {
      ok: false,
      response: buildError(c, 'domain_not_verified', 'domain must be verified'),
    };
  }
  if (!row.inbound_enabled) {
    return {
      ok: false,
      response: buildError(
        c,
        'domain_not_verified',
        'domain inbound must be enabled before MTA-STS/TLS-RPT',
      ),
    };
  }
  if (!row.cf_zone_id) {
    return {
      ok: false,
      response: buildError(c, 'bad_request', 'domain missing cf_zone_id; verify first'),
    };
  }
  const client = makeCfClient(c.env);
  if (!client) {
    return {
      ok: false,
      response: buildError(
        c,
        'cf_upstream',
        'CF_API_TOKEN and CF_ACCOUNT_ID env required for MTA-STS provisioning',
      ),
    };
  }
  return { ok: true, row, client };
}

// ---------- MTA-STS enable ----------
domainsMtaSts.post(
  '/v1/admin/domains/:id/mta-sts/enable',
  requireScope('admin:rotate'),
  async (c) => {
    const key = c.get('apiKey');
    const id = c.req.param('id');
    const row = await loadDomain(c.env, id);
    const pre = preflight(c, row);
    if (!pre.ok) return pre.response;

    // Reuse the existing policy_id if one is already set; otherwise mint a
    // fresh one. Sender caches key off this id (RFC 8461 §3.1) so we must
    // not churn it on idempotent re-enable.
    const policyId = pre.row.mta_sts_policy_id ?? generatePolicyId();
    let result;
    try {
      result = await provisionMtaSts(pre.client, {
        zoneId: pre.row.cf_zone_id!,
        domain: pre.row.name,
        policyId,
        workerName: WORKER_NAME,
      });
    } catch (e) {
      return buildError(
        c,
        'cf_upstream',
        `cf provision failed: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    }

    // First enable → 'testing'. Subsequent re-enables (mode already
    // 'testing' or 'enforce') preserve whatever the operator set last
    // this endpoint is safe to call on a healthy domain to re-publish.
    const newMode = pre.row.mta_sts_mode === 'none' ? 'testing' : pre.row.mta_sts_mode;
    const nowIso = new Date().toISOString();
    await c.env.DB.prepare(
      `UPDATE mail_domains
     SET mta_sts_mode = ?, mta_sts_policy_id = ?, updated_at = ?
     WHERE id = ?`,
    )
      .bind(newMode, policyId, nowIso, id)
      .run();

    await audit(c.env, {
      actor: `key:${key.key_id}`,
      action: 'mta_sts.enable',
      target: id,
      meta: {
        name: pre.row.name,
        mode: newMode,
        policy_id: policyId,
        provisioned: result,
      },
    });

    return c.json({
      id,
      mta_sts_mode: newMode,
      mta_sts_policy_id: policyId,
      provisioned: result,
    });
  },
);

// ---------- MTA-STS disable ----------
domainsMtaSts.post(
  '/v1/admin/domains/:id/mta-sts/disable',
  requireScope('admin:rotate'),
  async (c) => {
    const key = c.get('apiKey');
    const id = c.req.param('id');
    const row = await loadDomain(c.env, id);
    const pre = preflight(c, row);
    if (!pre.ok) return pre.response;

    try {
      await unprovisionMtaSts(pre.client, {
        zoneId: pre.row.cf_zone_id!,
        domain: pre.row.name,
      });
    } catch (e) {
      return buildError(
        c,
        'cf_upstream',
        `cf unprovision failed: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    }

    // Null the policy_id so a future re-enable mints a fresh one. A sender
    // that cached the old id will fall back to a new fetch when its
    // own `max_age` expires; we don't need to preserve the value here.
    const nowIso = new Date().toISOString();
    await c.env.DB.prepare(
      `UPDATE mail_domains
     SET mta_sts_mode = 'none', mta_sts_policy_id = NULL, updated_at = ?
     WHERE id = ?`,
    )
      .bind(nowIso, id)
      .run();

    await audit(c.env, {
      actor: `key:${key.key_id}`,
      action: 'mta_sts.disable',
      target: id,
      meta: {
        name: pre.row.name,
        prev_mode: pre.row.mta_sts_mode,
        prev_policy_id: pre.row.mta_sts_policy_id,
      },
    });

    return c.json({
      id,
      mta_sts_mode: 'none',
      mta_sts_policy_id: null,
      provisioned: { created: 0, skipped: 0, customDomainAttached: false },
    });
  },
);

// ---------- MTA-STS promote (testing → enforce) ----------
domainsMtaSts.post(
  '/v1/admin/domains/:id/mta-sts/promote',
  requireScope('admin:rotate'),
  async (c) => {
    const key = c.get('apiKey');
    const id = c.req.param('id');
    const row = await loadDomain(c.env, id);
    const pre = preflight(c, row);
    if (!pre.ok) return pre.response;
    if (pre.row.mta_sts_mode !== 'testing') {
      // RFC 8461 §5 lifecycle: promote is only valid from 'testing'. Going
      // straight to 'enforce' from 'none' would skip the sender-side
      // observation window and risks bouncing legitimate mail. The operator
      // should call /enable first to land in 'testing'.
      return buildError(
        c,
        'bad_request',
        `cannot promote: current mode is '${pre.row.mta_sts_mode}', must be 'testing'`,
      );
    }

    // Generate a fresh policy_id on promote. Per RFC 8461 §3.1 senders key
    // their cache off the id; bumping it forces a re-fetch of the policy
    // file (which now advertises mode: enforce).
    const newPolicyId = generatePolicyId();
    let result;
    try {
      result = await provisionMtaSts(pre.client, {
        zoneId: pre.row.cf_zone_id!,
        domain: pre.row.name,
        policyId: newPolicyId,
        workerName: WORKER_NAME,
      });
    } catch (e) {
      return buildError(
        c,
        'cf_upstream',
        `cf provision failed: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    }

    const nowIso = new Date().toISOString();
    await c.env.DB.prepare(
      `UPDATE mail_domains
     SET mta_sts_mode = 'enforce', mta_sts_policy_id = ?, updated_at = ?
     WHERE id = ?`,
    )
      .bind(newPolicyId, nowIso, id)
      .run();

    await audit(c.env, {
      actor: `key:${key.key_id}`,
      action: 'mta_sts.promote',
      target: id,
      meta: {
        name: pre.row.name,
        prev_policy_id: pre.row.mta_sts_policy_id,
        policy_id: newPolicyId,
        provisioned: result,
      },
    });

    return c.json({
      id,
      mta_sts_mode: 'enforce',
      mta_sts_policy_id: newPolicyId,
      provisioned: result,
    });
  },
);

// ---------- TLS-RPT enable ----------
domainsMtaSts.post(
  '/v1/admin/domains/:id/tls-rpt/enable',
  requireScope('admin:rotate'),
  async (c) => {
    const key = c.get('apiKey');
    const id = c.req.param('id');
    const row = await loadDomain(c.env, id);
    const pre = preflight(c, row);
    if (!pre.ok) return pre.response;

    // Body is optional; an empty/absent body falls back to env, then to a
    // hard-coded default. We accept both URL schemes that RFC 8460 permits
    // for `rua=`.
    let body: { rua?: string } = {};
    const raw = bodyText(c);
    if (raw && raw.length > 0) {
      try {
        body = JSON.parse(raw) as { rua?: string };
      } catch {
        return buildError(c, 'bad_request', 'invalid json body');
      }
    }
    const fallback = c.env.TLSRPT_DEFAULT_RUA ?? 'mailto:tlsrpt@plrs.im';
    const rua = body.rua ?? fallback;
    if (!/^mailto:/i.test(rua) && !/^https:\/\//i.test(rua)) {
      return buildError(c, 'bad_request', 'rua must begin with mailto: or https://');
    }

    let result;
    try {
      result = await provisionTlsRpt(pre.client, {
        zoneId: pre.row.cf_zone_id!,
        domain: pre.row.name,
        rua,
      });
    } catch (e) {
      return buildError(
        c,
        'cf_upstream',
        `cf provision failed: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    }

    const nowIso = new Date().toISOString();
    await c.env.DB.prepare(
      `UPDATE mail_domains
     SET tlsrpt_enabled = 1, tlsrpt_rua = ?, updated_at = ?
     WHERE id = ?`,
    )
      .bind(rua, nowIso, id)
      .run();

    await audit(c.env, {
      actor: `key:${key.key_id}`,
      action: 'tls_rpt.enable',
      target: id,
      meta: {
        name: pre.row.name,
        rua,
        prev_rua: pre.row.tlsrpt_rua,
        provisioned: result,
      },
    });

    return c.json({
      id,
      tlsrpt_enabled: 1,
      tlsrpt_rua: rua,
      provisioned: result,
    });
  },
);

// ---------- TLS-RPT disable ----------
domainsMtaSts.post(
  '/v1/admin/domains/:id/tls-rpt/disable',
  requireScope('admin:rotate'),
  async (c) => {
    const key = c.get('apiKey');
    const id = c.req.param('id');
    const row = await loadDomain(c.env, id);
    const pre = preflight(c, row);
    if (!pre.ok) return pre.response;

    try {
      await unprovisionTlsRpt(pre.client, {
        zoneId: pre.row.cf_zone_id!,
        domain: pre.row.name,
      });
    } catch (e) {
      return buildError(
        c,
        'cf_upstream',
        `cf unprovision failed: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    }

    // Keep tlsrpt_rua as a historical record — the operator may want to
    // re-enable with the same destination later, and there's no privacy
    // cost to leaving a `mailto:` string in D1.
    const nowIso = new Date().toISOString();
    await c.env.DB.prepare(
      `UPDATE mail_domains
     SET tlsrpt_enabled = 0, updated_at = ?
     WHERE id = ?`,
    )
      .bind(nowIso, id)
      .run();

    await audit(c.env, {
      actor: `key:${key.key_id}`,
      action: 'tls_rpt.disable',
      target: id,
      meta: {
        name: pre.row.name,
        prev_rua: pre.row.tlsrpt_rua,
      },
    });

    return c.json({
      id,
      tlsrpt_enabled: 0,
      tlsrpt_rua: pre.row.tlsrpt_rua,
      provisioned: { created: 0, skipped: 0, customDomainAttached: false },
    });
  },
);
