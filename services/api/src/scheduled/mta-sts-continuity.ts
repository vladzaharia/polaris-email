// W11 — MTA-STS continuity check.
//
// Every 6 hours, for each mail_domains row in mta_sts_mode='enforce':
//   1. DoH-resolve `_mta-sts.{domain}` TXT; compare to stored
//      mta_sts_policy_id. Drift -> log + alert.
//   2. fetch `https://mta-sts.{domain}/.well-known/mta-sts.txt`; verify
//      it advertises STSv1. Drift -> log + alert.
//
// Each check writes a row to synthetic_runs for the panel diagnostics view.

import { ulid } from '@polaris-mail/ids';
import { sendAlert } from '../lib/admin-alert.js';
import { runBatched } from '../lib/batch.js';
import type { Env } from '../env.js';

const DOMAIN_PARALLELISM = 10;

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

async function checkOneDomain(env: Env, d: DomainRow): Promise<boolean> {
  const start = Date.now();
  const expected = d.mta_sts_policy_id;
  if (!expected) {
    await recordRun(env, {
      target: d.name,
      ok: false,
      latency_ms: Date.now() - start,
      detail: { reason: 'no_policy_id_on_row' },
    });
    return false;
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
  if (!allOk) {
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
  return allOk;
}

export async function mtaStsContinuityRun(env: Env): Promise<MtaStsContinuityResult> {
  const rows = await env.DB.prepare(
    `SELECT id, name, mta_sts_policy_id, mta_sts_max_age
     FROM mail_domains
     WHERE mta_sts_mode = 'enforce' AND status NOT IN ('disabled')`,
  ).all<DomainRow>();
  const domains: DomainRow[] = rows.results ?? [];
  const outcomes = await runBatched(domains, DOMAIN_PARALLELISM, (d) => checkOneDomain(env, d));
  const ok = outcomes.filter((x) => x).length;
  const failed = outcomes.length - ok;
  return { candidates: domains.length, ok, failed };
}
