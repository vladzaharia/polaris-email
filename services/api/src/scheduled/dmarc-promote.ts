// W8 — DMARC policy auto-promotion cron.
//
// Runs daily. For each mail_domain with dmarc_promotion_mode='auto':
//   1. Aggregate the last 14 days of dmarc_alignment_rollup.
//   2. Compute DMARC-pass percentage + volume threshold.
//   3. Compute the recommended next state per the state machine.
//   4. If `dmarc_record_managed_by_polaris=1`, actually publish the DNS
//      change via packages/cf-api (W8 ties into the existing cf-api
//      surface). Otherwise just update the promotion_state column so the
//      panel can show "ready to promote".
//   5. On alignment drop below the rollback threshold, set
//      dmarc_promotion_mode='paused' + audit + fire admin alert.
//
// Soak periods + thresholds (all defaults; tunable via env):
//   * none           → quarantine_ready : ≥99% DMARC-pass × 14 days × ≥100 sessions/day avg
//   * quarantine_ready → quarantine     : 7-day cool-down with the panel-visible recommendation
//   * quarantine     → reject_ready     : ≥99.5% DMARC-pass × 30 days
//   * reject_ready   → reject           : 7-day cool-down
//
// Rollback (any state above 'none'):
//   * DMARC-pass < 95% over the last 24h × ≥50 sessions → pause + alert

import { sendAlert } from '../lib/admin-alert.js';
import { buildAuditInsert } from '../audit.js';
import type { Env } from '../env.js';

interface DomainRow {
  id: string;
  name: string;
  dmarc_policy: string | null;
  dmarc_promotion_mode: string;
  dmarc_promotion_state: string;
  dmarc_promotion_last_at: string | null;
  dmarc_record_managed_by_polaris: number;
}

interface AggregateRow {
  reports: number;
  total: number;
  dmarc_pass: number;
  earliest_day: string | null;
}

const SOAK_QUARANTINE_DAYS = 14;
const SOAK_REJECT_DAYS = 30;
const COOL_DOWN_DAYS = 7;
const QUARANTINE_PASS_THRESHOLD_PCT = 99;
const REJECT_PASS_THRESHOLD_PCT = 99.5;
const ROLLBACK_PASS_THRESHOLD_PCT = 95;
const MIN_DAILY_VOLUME = 100;
const ROLLBACK_MIN_VOLUME = 50;

function pctOf(pass: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((pass / total) * 10000) / 100;
}

interface WindowStats extends AggregateRow {
  /** Number of distinct calendar days that contributed rollup rows. */
  daysCovered: number;
}

async function aggregateWindow(env: Env, domain: string, days: number): Promise<WindowStats> {
  const since = new Date(Date.now() - days * 24 * 3_600_000).toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(reports), 0) AS reports,
            COALESCE(SUM(total_count), 0) AS total,
            COALESCE(SUM(dmarc_pass), 0) AS dmarc_pass,
            COUNT(DISTINCT day) AS days_covered,
            MIN(day) AS earliest_day
     FROM dmarc_alignment_rollup WHERE domain = ? AND day >= ?`,
  )
    .bind(domain, since)
    .first<{
      reports: number;
      total: number;
      dmarc_pass: number;
      days_covered: number;
      earliest_day: string | null;
    }>();
  return {
    reports: row?.reports ?? 0,
    total: row?.total ?? 0,
    dmarc_pass: row?.dmarc_pass ?? 0,
    earliest_day: row?.earliest_day ?? null,
    daysCovered: row?.days_covered ?? 0,
  };
}

function daysSince(iso: string | null): number {
  if (!iso) return Number.MAX_SAFE_INTEGER;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Number.MAX_SAFE_INTEGER;
  return Math.floor((Date.now() - t) / (24 * 3_600_000));
}

async function publishDmarcRecord(
  _env: Env,
  _domain: string,
  _newPolicy: 'quarantine' | 'reject',
): Promise<{ published: boolean; reason: string }> {
  // Hook: when packages/cf-api ships a `publishDmarcTxt(zone, domain, p)`
  // helper, this becomes the call site. Until then, mark as not-published
  // so the cron stays observe-only even when the managed flag is on.
  // Returning false here is the safe default: we never want to silently
  // touch operator DNS.
  return { published: false, reason: 'cf-api publish helper not yet wired (W8 follow-up)' };
}

async function transition(
  env: Env,
  domain: DomainRow,
  newState: string,
  newPolicy: string | null,
  reason: string,
  windowStats: AggregateRow,
): Promise<void> {
  const nowIso = new Date().toISOString();
  let dnsPublished = false;
  let publishNote = '';
  if (
    newPolicy &&
    domain.dmarc_record_managed_by_polaris === 1 &&
    (newState === 'quarantine' || newState === 'reject')
  ) {
    const r = await publishDmarcRecord(env, domain.name, newState as 'quarantine' | 'reject');
    dnsPublished = r.published;
    publishNote = r.reason;
  }

  const stmts = [
    env.DB.prepare(
      `UPDATE mail_domains
         SET dmarc_promotion_state = ?,
             dmarc_promotion_last_at = ?,
             dmarc_policy = COALESCE(?, dmarc_policy),
             updated_at = ?
        WHERE id = ?`,
    ).bind(newState, nowIso, dnsPublished ? newPolicy : null, nowIso, domain.id),
  ];
  const action = newState === 'paused' ? 'dmarc.pause' : 'dmarc.promote';
  const auditInsert = await buildAuditInsert(env, {
    actor: 'system:dmarc-promote-cron',
    action,
    target: domain.id,
    meta: {
      domain: domain.name,
      from_state: domain.dmarc_promotion_state,
      to_state: newState,
      new_policy: dnsPublished ? newPolicy : null,
      reason,
      dns_published: dnsPublished,
      publish_note: publishNote,
      window: windowStats,
    },
  });
  stmts.push(auditInsert.statement);
  await env.DB.batch(stmts);

  try {
    await sendAlert(env, {
      alert_type: newState === 'paused' ? 'dmarc_alignment_drop' : 'manual',
      severity: newState === 'paused' ? 'warn' : 'info',
      target: `domain:${domain.id}`,
      subject:
        newState === 'paused'
          ? `[POLARIS][WARN] DMARC promotion paused for ${domain.name}`
          : `[POLARIS][INFO] DMARC ${newState} for ${domain.name}`,
      body:
        `Domain: ${domain.name}\nFrom: ${domain.dmarc_promotion_state}\nTo: ${newState}\n` +
        `Reason: ${reason}\nDMARC pass: ${windowStats.dmarc_pass}/${windowStats.total} ` +
        `(${pctOf(windowStats.dmarc_pass, windowStats.total)}%)\nDNS published: ${dnsPublished}` +
        (publishNote ? `\nPublish note: ${publishNote}` : ''),
      payload: {
        from_state: domain.dmarc_promotion_state,
        to_state: newState,
        window: windowStats,
      },
    });
  } catch {
    /* non-fatal */
  }
}

export interface DmarcPromoteResult {
  candidates: number;
  promoted: number;
  paused: number;
  noOp: number;
  details: Array<{ domain: string; from: string; to: string; reason: string }>;
}

export async function dmarcPromoteRun(env: Env): Promise<DmarcPromoteResult> {
  const domains = await env.DB.prepare(
    `SELECT id, name, dmarc_policy, dmarc_promotion_mode, dmarc_promotion_state,
            dmarc_promotion_last_at, dmarc_record_managed_by_polaris
     FROM mail_domains
     WHERE dmarc_promotion_mode = 'auto'
       AND status NOT IN ('disabled')`,
  ).all<DomainRow>();
  const details: Array<{ domain: string; from: string; to: string; reason: string }> = [];
  let promoted = 0;
  let paused = 0;
  let noOp = 0;

  for (const d of domains.results ?? []) {
    // First check rollback (any non-'none' state).
    if (d.dmarc_promotion_state !== 'none') {
      const day1 = await aggregateWindow(env, d.name, 1);
      if (day1.total >= ROLLBACK_MIN_VOLUME) {
        const passPct = pctOf(day1.dmarc_pass, day1.total);
        if (passPct < ROLLBACK_PASS_THRESHOLD_PCT) {
          await transition(
            env,
            d,
            'paused',
            null,
            `rollback: 24h pass ${passPct}% < ${ROLLBACK_PASS_THRESHOLD_PCT}%`,
            day1,
          );
          paused++;
          details.push({
            domain: d.name,
            from: d.dmarc_promotion_state,
            to: 'paused',
            reason: 'rollback',
          });
          continue;
        }
      }
    }

    const w14 = await aggregateWindow(env, d.name, SOAK_QUARANTINE_DAYS);
    const w30 = await aggregateWindow(env, d.name, SOAK_REJECT_DAYS);
    const dailyAvg14 = w14.total / Math.max(SOAK_QUARANTINE_DAYS, 1);
    const passPct14 = pctOf(w14.dmarc_pass, w14.total);
    const passPct30 = pctOf(w30.dmarc_pass, w30.total);

    // State transitions.
    switch (d.dmarc_promotion_state) {
      case 'none': {
        if (
          dailyAvg14 >= MIN_DAILY_VOLUME &&
          passPct14 >= QUARANTINE_PASS_THRESHOLD_PCT &&
          w14.daysCovered >= SOAK_QUARANTINE_DAYS
        ) {
          await transition(
            env,
            d,
            'quarantine_ready',
            null,
            `${SOAK_QUARANTINE_DAYS}d pass ${passPct14}% ≥ ${QUARANTINE_PASS_THRESHOLD_PCT}% with avg ${dailyAvg14.toFixed(0)}/day`,
            w14,
          );
          promoted++;
          details.push({
            domain: d.name,
            from: 'none',
            to: 'quarantine_ready',
            reason: 'soak passed',
          });
        } else {
          noOp++;
        }
        break;
      }
      case 'quarantine_ready': {
        if (daysSince(d.dmarc_promotion_last_at) >= COOL_DOWN_DAYS) {
          await transition(env, d, 'quarantine', 'quarantine', 'cool-down elapsed', w14);
          promoted++;
          details.push({
            domain: d.name,
            from: 'quarantine_ready',
            to: 'quarantine',
            reason: 'cool-down elapsed',
          });
        } else {
          noOp++;
        }
        break;
      }
      case 'quarantine': {
        if (
          w30.daysCovered >= SOAK_REJECT_DAYS &&
          passPct30 >= REJECT_PASS_THRESHOLD_PCT &&
          w30.total / SOAK_REJECT_DAYS >= MIN_DAILY_VOLUME
        ) {
          await transition(
            env,
            d,
            'reject_ready',
            null,
            `${SOAK_REJECT_DAYS}d pass ${passPct30}% ≥ ${REJECT_PASS_THRESHOLD_PCT}%`,
            w30,
          );
          promoted++;
          details.push({
            domain: d.name,
            from: 'quarantine',
            to: 'reject_ready',
            reason: 'soak passed',
          });
        } else {
          noOp++;
        }
        break;
      }
      case 'reject_ready': {
        if (daysSince(d.dmarc_promotion_last_at) >= COOL_DOWN_DAYS) {
          await transition(env, d, 'reject', 'reject', 'cool-down elapsed', w14);
          promoted++;
          details.push({
            domain: d.name,
            from: 'reject_ready',
            to: 'reject',
            reason: 'cool-down elapsed',
          });
        } else {
          noOp++;
        }
        break;
      }
      default:
        noOp++;
    }
  }

  return {
    candidates: domains.results?.length ?? 0,
    promoted,
    paused,
    noOp,
    details,
  };
}
