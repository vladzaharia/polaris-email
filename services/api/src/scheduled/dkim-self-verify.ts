// W11 — DKIM self-verify cron.
//
// Every 6h (cron `30 */6 * * *`), for each mail_domains row that's
// verified + outbound-enabled, DoH-lookup the CNAME/TXT for each known
// DKIM selector and confirm a record exists. We don't try to verify the
// signature of recent messages here (that requires raw MIME + Web Crypto
// pipeline that's already exercised at send time); the cron's job is to
// catch DNS drift between the operator's CNAME and our expected target.

import { ulid } from '@polaris-email/ids';
import { sendAlert } from '../lib/admin-alert.js';
import { runBatched } from '../lib/batch.js';
import type { Env } from '../env.js';

const DOMAIN_PARALLELISM = 10;

interface DomainRow {
  id: string;
  name: string;
  dkim_selector: string | null;
}

interface DohAnswer {
  data: string;
  type: number;
}
interface DohResponse {
  Answer?: DohAnswer[];
}

async function dohAny(host: string): Promise<DohAnswer[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=ANY`;
  const r = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(5_000),
  });
  if (!r.ok) return [];
  const j = (await r.json()) as DohResponse;
  return j.Answer ?? [];
}

async function recordRun(
  env: Env,
  args: {
    target: string;
    ok: boolean;
    latency_ms: number;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO synthetic_runs (id, check_kind, target, ok, latency_ms, detail, run_at)
     VALUES (?, 'dkim_self_verify', ?, ?, ?, ?, ?)`,
  )
    .bind(
      ulid(),
      args.target,
      args.ok ? 1 : 0,
      args.latency_ms,
      JSON.stringify(args.detail),
      new Date().toISOString(),
    )
    .run();
}

export interface DkimSelfVerifyResult {
  candidates: number;
  ok: number;
  failed: number;
}

async function checkOneDomain(env: Env, d: DomainRow): Promise<boolean> {
  const start = Date.now();
  // Always check the canonical CF selector AND any polaris-namespace
  // selectors recorded on the row (legacy `cf`, the active dkim_keys
  // entries).
  const checked: Array<{ selector: string; recordCount: number }> = [];
  const selectorsToCheck = new Set<string>([d.dkim_selector ?? 'cf', 'cf2024-1']);
  const dkimRows = await env.DB.prepare(
    `SELECT selector FROM dkim_keys WHERE domain_id = ? AND state IN ('pending','active')`,
  )
    .bind(d.id)
    .all<{ selector: string }>();
  for (const k of dkimRows.results ?? []) selectorsToCheck.add(k.selector);

  // Resolve selectors in parallel — each domain has at most ~4 selectors so
  // this stays inside the DoH RPS envelope even when the outer batch is full.
  const selectorList = [...selectorsToCheck];
  const ansList = await Promise.all(
    selectorList.map((sel) => dohAny(`${sel}._domainkey.${d.name}`).catch(() => [] as DohAnswer[])),
  );
  let anyMissing = false;
  for (let i = 0; i < selectorList.length; i++) {
    const sel = selectorList[i]!;
    const ans = ansList[i]!;
    checked.push({ selector: sel, recordCount: ans.length });
    if (ans.length === 0) anyMissing = true;
  }
  const allOk = !anyMissing;
  await recordRun(env, {
    target: d.name,
    ok: allOk,
    latency_ms: Date.now() - start,
    detail: { selectors: checked },
  });
  if (!allOk) {
    try {
      await sendAlert(env, {
        alert_type: 'synthetic_check_failed',
        severity: 'warn',
        target: `domain:${d.id}`,
        subject: `[POLARIS][WARN] DKIM self-verify gap for ${d.name}`,
        body: `One or more DKIM selectors returned no DNS records for ${d.name}.\nChecked: ${checked
          .map((c) => `${c.selector}=${c.recordCount}`)
          .join(', ')}`,
        payload: { domain: d.name, checked },
      });
    } catch {
      /* non-fatal */
    }
  }
  return allOk;
}

export async function dkimSelfVerifyRun(env: Env): Promise<DkimSelfVerifyResult> {
  const rows = await env.DB.prepare(
    `SELECT id, name, dkim_selector FROM mail_domains
     WHERE outbound_enabled = 1 AND status = 'verified'`,
  ).all<DomainRow>();
  const domains: DomainRow[] = rows.results ?? [];
  const outcomes = await runBatched(domains, DOMAIN_PARALLELISM, (d) => checkOneDomain(env, d));
  const ok = outcomes.filter((x) => x).length;
  const failed = outcomes.length - ok;
  return { candidates: domains.length, ok, failed };
}
