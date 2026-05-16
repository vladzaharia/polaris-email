// W11 — MTA-STS continuity check.
//
// Every 6 hours, for each mail_domains row in mta_sts_mode='enforce':
//   1. DoH-resolve `_mta-sts.{domain}` TXT; compare to stored
//      mta_sts_policy_id. Drift -> log + alert.
//   2. fetch `https://mta-sts.{domain}/.well-known/mta-sts.txt`; verify
//      it advertises STSv1. Drift -> log + alert.
//
// Each check writes a row to synthetic_runs for the panel diagnostics view.

import { ulid } from '@polaris-email/ids';
import { sendAlert } from '../lib/admin-alert.js';
import type { Env } from '../env.js';

interface DomainRow {
  id: string;
  name: string;
  mta_sts_policy_id: string | null;
  mta_sts_max_age: number | null;
}

interface DohAnswer {
  data: string;
  type: number;
}
interface DohResponse {
  Answer?: DohAnswer[];
}

async function dohTxt(host: string): Promise<string[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=TXT`;
  const r = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(5_000),
  });
  if (!r.ok) return [];
  const j = (await r.json()) as DohResponse;
  return (j.Answer ?? [])
    .filter((a) => a.type === 16)
    .map((a) => {
      const chunks = a.data.match(/"([^"]*)"/g);
      return chunks ? chunks.map((c) => c.slice(1, -1)).join('') : a.data.trim();
    });
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
     VALUES (?, 'mta_sts_continuity', ?, ?, ?, ?, ?)`,
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

export interface MtaStsContinuityResult {
  candidates: number;
  ok: number;
  failed: number;
}

export async function mtaStsContinuityRun(env: Env): Promise<MtaStsContinuityResult> {
  const rows = await env.DB.prepare(
    `SELECT id, name, mta_sts_policy_id, mta_sts_max_age
     FROM mail_domains
     WHERE mta_sts_mode = 'enforce' AND status NOT IN ('disabled')`,
  ).all<DomainRow>();
  let ok = 0;
  let failed = 0;
  for (const d of rows.results ?? []) {
    const start = Date.now();
    const expected = d.mta_sts_policy_id;
    if (!expected) {
      await recordRun(env, {
        target: d.name,
        ok: false,
        latency_ms: Date.now() - start,
        detail: { reason: 'no_policy_id_on_row' },
      });
      failed++;
      continue;
    }
    const txts = await dohTxt('_mta-sts.' + d.name).catch(() => [] as string[]);
    const observedIds = txts
      .map((t) => /id=([0-9A-Za-z]+)/.exec(t)?.[1])
      .filter((s): s is string => !!s);
    const dnsOk = observedIds.includes(expected);
    let policyOk = false;
    let fetchStatus: number | null = null;
    let maxAge: string | null = null;
    try {
      const r = await fetch('https://mta-sts.' + d.name + '/.well-known/mta-sts.txt', {
        signal: AbortSignal.timeout(5_000),
      });
      fetchStatus = r.status;
      if (r.ok) {
        const body = await r.text();
        const maxAgeMatch = /max_age:\s*(\d+)/.exec(body);
        maxAge = maxAgeMatch?.[1] ?? null;
        policyOk = body.includes('STSv1');
      }
    } catch {
      /* ignore */
    }
    const allOk = dnsOk && policyOk;
    await recordRun(env, {
      target: d.name,
      ok: allOk,
      latency_ms: Date.now() - start,
      detail: {
        expected_policy_id: expected,
        observed_policy_ids: observedIds,
        dns_ok: dnsOk,
        policy_ok: policyOk,
        fetch_status: fetchStatus,
        max_age: maxAge,
      },
    });
    if (allOk) {
      ok++;
    } else {
      failed++;
      try {
        await sendAlert(env, {
          alert_type: 'tls_rpt_failure_burst',
          severity: 'warn',
          target: 'domain:' + d.id,
          subject: '[POLARIS][WARN] MTA-STS drift detected for ' + d.name,
          body:
            'MTA-STS continuity check failed for ' +
            d.name +
            '. Expected policy_id ' +
            expected +
            ', observed ' +
            (observedIds.join(', ') || '(none)') +
            '. DNS ok=' +
            String(dnsOk) +
            ' policy_ok=' +
            String(policyOk),
          payload: {
            domain: d.name,
            expected,
            observed: observedIds,
            dnsOk,
            policyOk,
            fetchStatus,
          },
        });
      } catch {
        /* non-fatal */
      }
    }
  }
  return { candidates: rows.results?.length ?? 0, ok, failed };
}
