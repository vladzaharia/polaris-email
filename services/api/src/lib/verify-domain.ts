// Domain verification — the single source of truth for the
// reconciliation flow that turns a `pending` mail_domain into
// `verified` and keeps DMARC/MTA-STS/TLS-RPT state in sync with what
// the operator's DNS actually publishes.
//
// Two callers share this:
//   * POST /v1/admin/domains/:id/verify — operator-initiated
//     (services/api/src/routes/admin/domains.ts)
//   * Hourly cron — background freshness pass
//     (services/api/src/scheduled/domain-verify.ts)
//
// Both call `verifyDomain(env, id, actor)` and consume the same
// outcome + response shape. The `actor` argument is what audit_log
// records — operator id from the route, the literal string 'system'
// from the cron.
//
// Side effects, in order:
//   1. DMARC reconciliation — if dmarc_record_managed_by_polaris=0,
//      read live `_dmarc.<name>` TXT and UPDATE dmarc_policy /
//      dmarc_rua / dmarc_promotion_state.
//   2. CF Email Routing DNS check (MX + CNAMEs).
//   3. MTA-STS / TLS-RPT layered checks when enabled.
//   4. On core pass — UPDATE status='verified', verified_at, and any
//      sub-layer *_verified_at timestamps; emit `domain.verify` audit.
//   5. Otherwise — persist any sub-layer that passed; emit
//      `domain.verify_incomplete` audit.

import { verifyMtaSts, verifyTlsRpt } from '@polaris-mail/cf-api';
import { audit } from '../audit.js';
import type { Env } from '../env.js';

export interface VerifyCheck {
  name: string;
  ok: boolean;
  expected: string;
  actual: string;
  /**
   * `true` (default) = core check that gates the `verified` transition.
   * `false` = optional hardening (MTA-STS, TLS-RPT) — surfaced but does
   * not block.
   */
  required?: boolean;
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
  dmarc_policy: string | null;
  dmarc_rua: string | null;
  dmarc_promotion_state: string;
  dmarc_record_managed_by_polaris: number;
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

export type VerifyOutcome =
  /** Row not found. */
  | 'not_found'
  /** CF API creds missing — verification can't run. */
  | 'no_creds'
  /** All core checks failed or only some passed; status unchanged. */
  | 'incomplete'
  /** All core checks passed; status flipped to 'verified'. */
  | 'verified';

export interface VerifyResponse {
  id: string;
  status: string;
  verified_at?: number;
  message?: string;
  checks: VerifyCheck[];
}

export interface VerifyResult {
  outcome: VerifyOutcome;
  response: VerifyResponse;
}

const DNS_CNAME = 5;
const DNS_MX = 15;
const DNS_TXT = 16;

async function dohResolve(host: string, type: 'CNAME' | 'MX' | 'TXT'): Promise<DohAnswer[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) return [];
  const j = (await res.json()) as DohResponse;
  if (!j.Answer || !Array.isArray(j.Answer)) return [];
  const want = type === 'CNAME' ? DNS_CNAME : type === 'MX' ? DNS_MX : DNS_TXT;
  return j.Answer.filter((a) => a.type === want);
}

function stripDot(s: string): string {
  return s.endsWith('.') ? s.slice(0, -1) : s;
}

/**
 * Parse the contents of a `_dmarc.<domain>` TXT record (RFC 7489 §6.3).
 * Returns null when the record doesn't parse as DMARC at all.
 */
function parseDmarcTxt(raw: string): { policy: string; sp?: string; rua?: string } | null {
  let s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1).replace(/""/g, '');
  }
  const parts = s
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts[0]!.toLowerCase() !== 'v=dmarc1') return null;
  const out: { policy?: string; sp?: string; rua?: string } = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim().toLowerCase();
    const v = part.slice(eq + 1).trim();
    if (k === 'p') out.policy = v.toLowerCase();
    else if (k === 'sp') out.sp = v.toLowerCase();
    else if (k === 'rua') out.rua = v;
  }
  if (!out.policy) return null;
  return { policy: out.policy, sp: out.sp, rua: out.rua };
}

function promotionStateFromPolicy(policy: string): string {
  if (policy === 'reject') return 'reject';
  if (policy === 'quarantine') return 'quarantine';
  return 'none';
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

export async function verifyDomain(env: Env, id: string, actor: string): Promise<VerifyResult> {
  const row = await env.DB.prepare(
    `SELECT id, name, status, cf_zone_id,
            mta_sts_mode, mta_sts_policy_id, tlsrpt_enabled, tlsrpt_rua,
            dmarc_policy, dmarc_rua, dmarc_promotion_state,
            dmarc_record_managed_by_polaris
     FROM mail_domains WHERE id = ?`,
  )
    .bind(id)
    .first<VerifyDomainRow>();
  if (!row) {
    return {
      outcome: 'not_found',
      response: { id, status: 'unknown', message: 'mail_domain not found', checks: [] },
    };
  }

  // ---------- DMARC reconciliation ----------
  if (row.dmarc_record_managed_by_polaris === 0) {
    const dmarcTxts = await dohResolve(`_dmarc.${row.name}`, 'TXT').catch(() => []);
    for (const ans of dmarcTxts) {
      const parsed = parseDmarcTxt(ans.data);
      if (!parsed) continue;
      const newPromotionState = promotionStateFromPolicy(parsed.policy);
      const policyChanged = parsed.policy !== row.dmarc_policy;
      const ruaChanged = (parsed.rua ?? null) !== row.dmarc_rua;
      const promotionChanged = newPromotionState !== row.dmarc_promotion_state;
      if (policyChanged || ruaChanged || promotionChanged) {
        const nowIso = new Date().toISOString();
        await env.DB.prepare(
          `UPDATE mail_domains
             SET dmarc_policy = ?, dmarc_rua = ?, dmarc_promotion_state = ?,
                 dmarc_promotion_last_at = ?, updated_at = ?
           WHERE id = ?`,
        )
          .bind(parsed.policy, parsed.rua ?? null, newPromotionState, nowIso, nowIso, id)
          .run();
        row.dmarc_policy = parsed.policy;
        row.dmarc_rua = parsed.rua ?? null;
        row.dmarc_promotion_state = newPromotionState;
        await audit(env, {
          actor,
          // Re-using the generic `domain.update` action — adding a
          // dedicated `domain.dmarc_sync` would require an audit_log
          // CHECK migration. `meta.via` disambiguates from operator
          // PATCHes.
          action: 'domain.update',
          target: id,
          meta: {
            name: row.name,
            via: 'dmarc_sync',
            policy: parsed.policy,
            rua: parsed.rua ?? null,
            promotion_state: newPromotionState,
            source: '_dmarc-txt',
          },
        });
      }
      break; // first valid DMARC TXT wins (RFC 7489 §6.6.3)
    }
  }

  const checks: VerifyCheck[] = [];
  const coreChecks: VerifyCheck[] = [];

  const apiToken = env.CF_API_TOKEN;
  const accountId = env.CF_ACCOUNT_ID;
  const haveCfCreds = !!(apiToken && accountId && row.cf_zone_id);
  if (!haveCfCreds) {
    checks.push({
      name: 'cf-email-routing-dns',
      ok: false,
      expected: 'CF API token + cached zone id',
      actual: 'missing CF_API_TOKEN, CF_ACCOUNT_ID or cf_zone_id',
    });
    await audit(env, {
      actor,
      action: 'domain.verify_incomplete',
      target: id,
      meta: { name: row.name, reason: 'no-cf-creds' },
    });
    return {
      outcome: 'no_creds',
      response: { id, status: row.status, message: 'verification incomplete', checks },
    };
  }
  const expected = await fetchExpectedRoutingDns(accountId!, row.cf_zone_id!, apiToken!).catch(
    () => [] as RoutingDnsRecord[],
  );

  // ---------- CNAME checks ----------
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
    const cnameCheck: VerifyCheck = {
      name: `cname:${rec.name}`,
      ok: seen.includes(want),
      expected: want,
      actual: seen.join(',') || '(empty)',
    };
    checks.push(cnameCheck);
    coreChecks.push(cnameCheck);
  }

  // ---------- MX check ----------
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
  const mxCheck: VerifyCheck = {
    name: 'mx',
    ok: mxOk,
    expected: wantMxSet.join(','),
    actual: haveMxSet.join(',') || '(empty)',
  };
  checks.push(mxCheck);
  coreChecks.push(mxCheck);

  // ---------- MTA-STS sub-block ----------
  let mtaStsRanAndAllPassed = false;
  if (row.mta_sts_mode !== 'none') {
    const mtaSts = await verifyMtaSts(row.name, row.mta_sts_policy_id, {
      localPolicyResolver: async () => {
        if (!row.mta_sts_mode || row.mta_sts_mode === 'none') return null;
        const policyRow = await env.DB.prepare(
          `SELECT mta_sts_mode, mta_sts_max_age FROM mail_domains WHERE id = ?`,
        )
          .bind(row.id)
          .first<{ mta_sts_mode: string; mta_sts_max_age: number }>();
        if (!policyRow || policyRow.mta_sts_mode === 'none') return null;
        const body =
          `version: STSv1\r\n` +
          `mode: ${policyRow.mta_sts_mode}\r\n` +
          `mx: *.mx.cloudflare.net\r\n` +
          `max_age: ${policyRow.mta_sts_max_age}\r\n`;
        return { body, contentType: 'text/plain; charset=utf-8' };
      },
    });
    checks.push(...mtaSts.checks);
    const someFailed = mtaSts.checks.some((ch) => !ch.ok);
    if (someFailed) {
      checks.push({
        name: `mta-sts:operator-action:${row.name}`,
        ok: false,
        expected: `mode=${row.mta_sts_mode}, policy_id=${row.mta_sts_policy_id ?? '(unset)'}`,
        actual: `MTA-STS records require manual re-provisioning. Call POST /v1/admin/domains/${row.id}/mta-sts/enable to publish.`,
        required: false,
      });
    } else {
      mtaStsRanAndAllPassed = true;
    }
  }

  // ---------- TLS-RPT sub-block ----------
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
        required: false,
      });
    } else {
      tlsRptRanAndAllPassed = true;
    }
  }

  const coreOk = coreChecks.length > 0 && coreChecks.every((ch) => ch.ok);
  const allOk = checks.length > 0 && checks.every((ch) => ch.ok);
  const nowIso = new Date().toISOString();

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

  if (coreOk) {
    const fullSet = ['status = ?', 'verified_at = ?', 'last_verify_check_at = ?', 'updated_at = ?'];
    const fullBinds: unknown[] = ['verified', nowIso, nowIso, nowIso];
    if (subUpdates.length) {
      fullSet.push(...subUpdates);
      fullBinds.push(...subBinds);
    }
    fullBinds.push(id);
    await env.DB.prepare(`UPDATE mail_domains SET ${fullSet.join(', ')} WHERE id = ?`)
      .bind(...fullBinds)
      .run();
    await audit(env, {
      actor,
      action: 'domain.verify',
      target: id,
      meta: {
        name: row.name,
        checks: checks.map((c2) => c2.name),
        all_layers_ok: allOk,
      },
    });
    return {
      outcome: 'verified',
      response: { id, status: 'verified', verified_at: Date.now(), checks },
    };
  }

  // Even when overall verify failed, persist any sub-block that did pass.
  if (subUpdates.length) {
    await env.DB.prepare(
      `UPDATE mail_domains SET ${subUpdates.join(', ')}, updated_at = ? WHERE id = ?`,
    )
      .bind(...subBinds, nowIso, id)
      .run();
  }

  await audit(env, {
    actor,
    action: 'domain.verify_incomplete',
    target: id,
    meta: {
      name: row.name,
      failures: checks.filter((ch) => !ch.ok).map((ch) => ch.name),
    },
  });
  return {
    outcome: 'incomplete',
    response: { id, status: row.status, message: 'verification incomplete', checks },
  };
}
