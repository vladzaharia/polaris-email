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
import type { Env } from '../env.js';

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

export async function dkimSelfVerifyRun(env: Env): Promise<DkimSelfVerifyResult> {
  const rows = await env.DB.prepare(
    `SELECT id, name, dkim_selector FROM mail_domains
     WHERE outbound_enabled = 1 AND status = 'verified'`,
  ).all<DomainRow>();
  let ok = 0;
  let failed = 0;
  for (const d of rows.results ?? []) {
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

    let anyMissing = false;
    for (const sel of selectorsToCheck) {
      const host = `${sel}._domainkey.${d.name}`;
      const ans = await dohAny(host).catch(() => [] as DohAnswer[]);
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
    if (allOk) {
      ok++;
    } else {
      failed++;
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
  }
  return { candidates: rows.results?.length ?? 0, ok, failed };
}
