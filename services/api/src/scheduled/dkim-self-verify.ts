// W11 — DKIM self-verify cron.
//
// Every 6h (cron `30 */6 * * *`), for each mail_domains row that's
// verified + outbound-enabled, DoH-lookup the outbound DKIM record and
// confirm it resolves. We don't try to verify the signature of recent
// messages here (that requires raw MIME + Web Crypto pipeline that's
// already exercised at send time); the cron's job is catching DNS drift
// after onboarding — a record that was published correctly but later
// disappeared (operator manually deleted it, CF rotation didn't
// propagate, registrar change clobbered the zone).
//
// Selector model:
//   * `cf-bounce` is CF's canonical Email Sending DKIM selector (CF
//     publishes the DKIM TXT at `cf-bounce._domainkey.<domain>`, per
//     https://developers.cloudflare.com/email-service/configuration/domains/).
//     This is what receivers verify against for mail signed by CF.
//   * Any rows in `dkim_keys` with state pending/active — captures
//     operator-managed selectors (custom keys, in-flight rotation).
//
// Selectors we deliberately do NOT check:
//   * `cf2024-1` — CF's Email Routing DKIM, an inbound infra record
//     unrelated to outbound signing. Used to be hardcoded here; that
//     was wrong and caused false alerts on domains without routing.
//   * `dkim_selector` from mail_domains (default `polaris1` or `cf`)
//     — historical, never actually published by CF Email Sending.
//
// Sender-onboarded gate:
//   Before checking DKIM, DoH-probe the MX at `cf-bounce.<domain>`. CF
//   only publishes the cf-bounce subdomain when Email Sending is
//   onboarded; if it doesn't resolve, the domain is mid-onboarding (or
//   was never onboarded) and the DKIM record won't exist yet. Skip
//   silently — the operator gets a separate signal from the
//   sender_onboarded inspector. We do still record the skip in
//   synthetic_runs so the cron's coverage is observable.

import { ulid } from '@polaris-mail/ids';
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

async function doh(host: string, type: 'ANY' | 'MX' | 'TXT'): Promise<DohAnswer[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`;
  const r = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(5_000),
  });
  if (!r.ok) return [];
  const j = (await r.json()) as DohResponse;
  return j.Answer ?? [];
}

type RunOutcome = 'ok' | 'failed' | 'skipped';

async function recordRun(
  env: Env,
  args: {
    target: string;
    outcome: RunOutcome;
    latency_ms: number;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  // `ok` semantics for the diagnostics widget summary: a skipped run is
  // not a failure — the cron consciously decided this domain doesn't
  // need verification (no Email Sending records published, so a missing
  // DKIM is the expected state). Counting it as a pass keeps the
  // per-check_kind pass rate honest. The detail JSON still carries
  // `outcome: 'skipped'` so anyone drilling into individual rows can
  // distinguish a real pass from a deliberate skip.
  await env.DB.prepare(
    `INSERT INTO synthetic_runs (id, check_kind, target, ok, latency_ms, detail, run_at)
     VALUES (?, 'dkim_self_verify', ?, ?, ?, ?, ?)`,
  )
    .bind(
      ulid(),
      args.target,
      args.outcome === 'failed' ? 0 : 1,
      args.latency_ms,
      JSON.stringify({ outcome: args.outcome, ...args.detail }),
      new Date().toISOString(),
    )
    .run();
}

export interface DkimSelfVerifyResult {
  candidates: number;
  ok: number;
  failed: number;
  skipped: number;
}

async function checkOneDomain(env: Env, d: DomainRow): Promise<RunOutcome> {
  const start = Date.now();

  // Sender-onboarded gate. CF only publishes `cf-bounce.<domain>` MX
  // records when Email Sending is onboarded; absence means the domain
  // isn't expected to have an outbound DKIM record yet. Skip rather
  // than alert — onboarding state is reported elsewhere (inspectZone +
  // the panel's Sender row). Routing-only domains (cf2024-1 present but
  // no cf-bounce) should not appear here.
  const bounceMx = await doh(`cf-bounce.${d.name}`, 'MX').catch(() => [] as DohAnswer[]);
  if (bounceMx.length === 0) {
    await recordRun(env, {
      target: d.name,
      outcome: 'skipped',
      latency_ms: Date.now() - start,
      detail: { reason: 'sender_not_onboarded' },
    });
    return 'skipped';
  }

  // CF-managed Email Sending DKIM lives at `cf-bounce._domainkey`. Any
  // legacy/operator-managed selectors recorded on `dkim_keys` get
  // checked too so in-flight rotations don't get missed.
  const checked: Array<{ selector: string; recordCount: number }> = [];
  const selectorsToCheck = new Set<string>(['cf-bounce']);
  const dkimRows = await env.DB.prepare(
    `SELECT selector FROM dkim_keys WHERE domain_id = ? AND state IN ('pending','active')`,
  )
    .bind(d.id)
    .all<{ selector: string }>();
  for (const k of dkimRows.results ?? []) selectorsToCheck.add(k.selector);

  const selectorList = [...selectorsToCheck];
  const ansList = await Promise.all(
    selectorList.map((sel) =>
      doh(`${sel}._domainkey.${d.name}`, 'TXT').catch(() => [] as DohAnswer[]),
    ),
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
    outcome: allOk ? 'ok' : 'failed',
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
  return allOk ? 'ok' : 'failed';
}

export async function dkimSelfVerifyRun(env: Env): Promise<DkimSelfVerifyResult> {
  const rows = await env.DB.prepare(
    `SELECT id, name, dkim_selector FROM mail_domains
     WHERE outbound_enabled = 1 AND status = 'verified'`,
  ).all<DomainRow>();
  const domains: DomainRow[] = rows.results ?? [];
  const outcomes = await runBatched(domains, DOMAIN_PARALLELISM, (d) => checkOneDomain(env, d));
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  for (const o of outcomes) {
    if (o === 'ok') ok += 1;
    else if (o === 'skipped') skipped += 1;
    else failed += 1;
  }
  return { candidates: domains.length, ok, failed, skipped };
}
