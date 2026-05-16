// W2c — Sender abuse threshold cron.
//
// Runs every 15 minutes. For each principal (sender_address | mailbox |
// domain) with abuse_events in the last 24h:
//   1. Aggregate weighted events.
//   2. Compare against the per-tier threshold for that principal type.
//   3. If breached AND no active sender suppression already exists, fire:
//      a) insert a sender suppression with the duration for the current tier
//      b) advance current_tier in sender_abuse_profile (cap at 5)
//      c) increment lifetime_event_count + lifetime_weighted_score
//      d) audit `sender.suppress_auto` + `sender_abuse_profile.tier_advance`
//      e) fire admin alert via W2d sendAlert()
//
// Critical-event bypass: any abuse_events row classified as
// `phishing_report` or `legal_takedown` within the last 24h fires
// suppression at the next tier even if the weighted count is 1.
//
// Idempotency: the cron is a no-op for principals that already have a
// non-expired sender suppression at the matching scope. Re-running within
// the same minute is safe.
//
// The cron uses the W1 suppressions ON CONFLICT DO NOTHING semantic so a
// race with a parallel writer can never create duplicate rows.

import { ulid } from '@polaris-email/ids';
import { sendAlert } from '../lib/admin-alert.js';
import { buildAuditInsert } from '../audit.js';
import type { Env } from '../env.js';

type PrincipalType = 'sender_address' | 'mailbox' | 'domain';

interface ThresholdConfig {
  // Per-tier triggering threshold (weighted events in 24h).
  triggers: [number, number, number, number, number]; // tiers 0..4 (tier 5 never fires)
  // Per-tier suppression duration. `null` = permanent.
  durations: [number, number, number, number, null]; // seconds for tiers 0..3, null for tier 4
  // Multiplier vs per-sender_address baseline.
  multiplier: number;
}

const BASE: ThresholdConfig = {
  triggers: [5, 4, 3, 2, 1],
  durations: [
    24 * 3600, // tier 0 → 24h
    7 * 24 * 3600, // tier 1 → 7d
    30 * 24 * 3600, // tier 2 → 30d
    90 * 24 * 3600, // tier 3 → 90d
    null, // tier 4 → permanent
  ],
  multiplier: 1,
};

const MAILBOX_CONFIG: ThresholdConfig = {
  triggers: [
    BASE.triggers[0] * 3,
    BASE.triggers[1] * 3,
    BASE.triggers[2] * 3,
    BASE.triggers[3] * 3,
    BASE.triggers[4] * 3,
  ] as ThresholdConfig['triggers'],
  durations: BASE.durations,
  multiplier: 3,
};

const DOMAIN_CONFIG: ThresholdConfig = {
  triggers: [
    BASE.triggers[0] * 10,
    BASE.triggers[1] * 10,
    BASE.triggers[2] * 10,
    BASE.triggers[3] * 10,
    BASE.triggers[4] * 10,
  ] as ThresholdConfig['triggers'],
  durations: BASE.durations,
  multiplier: 10,
};

function configFor(principalType: PrincipalType): ThresholdConfig {
  switch (principalType) {
    case 'mailbox':
      return MAILBOX_CONFIG;
    case 'domain':
      return DOMAIN_CONFIG;
    default:
      return BASE;
  }
}

interface ProfileRow {
  principal_type: PrincipalType;
  principal_id: string;
  lifetime_event_count: number;
  lifetime_weighted_score: number;
  suppression_count: number;
  current_tier: number;
  current_tier_started_at: string | null;
  last_suppressed_at: string | null;
  last_event_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AggregateRow {
  principal_id: string;
  event_count: number;
  weighted_24h: number;
  has_critical: number;
  last_event_at: string;
}

function principalColumnFor(t: PrincipalType): string {
  switch (t) {
    case 'sender_address':
      return 'sender_address';
    case 'mailbox':
      return 'sender_principal_mailbox_id';
    case 'domain':
      return 'sender_principal_domain_id';
  }
}

async function aggregateRecent(
  env: Env,
  t: PrincipalType,
  sinceIso: string,
): Promise<AggregateRow[]> {
  const col = principalColumnFor(t);
  const sql = `
    SELECT ${col} AS principal_id,
           COUNT(*) AS event_count,
           COALESCE(SUM(weight), 0) AS weighted_24h,
           MAX(CASE WHEN classification IN ('phishing_report','legal_takedown') THEN 1 ELSE 0 END) AS has_critical,
           MAX(reported_at) AS last_event_at
    FROM abuse_events
    WHERE ${col} IS NOT NULL AND reported_at >= ?
    GROUP BY ${col}
    HAVING COUNT(*) > 0`;
  const rows = await env.DB.prepare(sql).bind(sinceIso).all<AggregateRow>();
  return rows.results ?? [];
}

async function loadProfile(env: Env, t: PrincipalType, id: string): Promise<ProfileRow | null> {
  return env.DB.prepare(
    `SELECT * FROM sender_abuse_profile WHERE principal_type = ? AND principal_id = ?`,
  )
    .bind(t, id)
    .first<ProfileRow>();
}

async function activeSenderSuppressionExists(
  env: Env,
  t: PrincipalType,
  id: string,
  nowIso: string,
): Promise<boolean> {
  const scope = t;
  const row = await env.DB.prepare(
    `SELECT id FROM suppressions
       WHERE entity_type = 'sender' AND scope = ? AND scope_target = ?
         AND disabled_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       LIMIT 1`,
  )
    .bind(scope, id, nowIso)
    .first<{ id: string }>();
  return !!row;
}

function describeFor(t: PrincipalType, id: string): string {
  switch (t) {
    case 'sender_address':
      return `sender ${id}`;
    case 'mailbox':
      return `mailbox ${id}`;
    case 'domain':
      return `domain ${id}`;
  }
}

interface AddressLookup {
  normalized: string;
  local: string | null;
  domain: string | null;
}

function fallbackNormalize(addr: string): AddressLookup {
  const t = addr.trim().replace(/^<|>$/g, '').toLowerCase();
  const at = t.lastIndexOf('@');
  if (at <= 0) return { normalized: t, local: null, domain: null };
  return { normalized: t, local: t.slice(0, at), domain: t.slice(at + 1) };
}

async function fireOne(
  env: Env,
  t: PrincipalType,
  id: string,
  agg: AggregateRow,
  nowMs: number,
): Promise<{ fired: boolean; reason: string }> {
  const nowIso = new Date(nowMs).toISOString();
  if (await activeSenderSuppressionExists(env, t, id, nowIso)) {
    return { fired: false, reason: 'already_suppressed' };
  }

  const profile = (await loadProfile(env, t, id)) ?? {
    principal_type: t,
    principal_id: id,
    lifetime_event_count: 0,
    lifetime_weighted_score: 0,
    suppression_count: 0,
    current_tier: 0,
    current_tier_started_at: null,
    last_suppressed_at: null,
    last_event_at: null,
    created_at: nowIso,
    updated_at: nowIso,
  };

  const tier = Math.min(profile.current_tier, 5);
  if (tier >= 5) {
    return { fired: false, reason: 'tier_5_permanent_already' };
  }
  const cfg = configFor(t);
  const trigger = cfg.triggers[tier as 0 | 1 | 2 | 3 | 4];
  const duration = cfg.durations[tier as 0 | 1 | 2 | 3 | 4];
  const hasCritical = agg.has_critical === 1;

  // Trigger check — bypass for critical, otherwise compare against threshold.
  if (!hasCritical && agg.weighted_24h < trigger) {
    return { fired: false, reason: `under_threshold (${agg.weighted_24h} < ${trigger})` };
  }

  // Fire — duration based on tier.
  const expiresAt = duration === null ? null : new Date(nowMs + duration * 1000).toISOString();

  // Build the sender suppression row. For sender_address scope, we also need
  // the normalized address; for mailbox/domain scope, address_normalized is
  // the principal id (a placeholder for the lookup index).
  const scope: 'sender_address' | 'mailbox' | 'domain' = t;
  const addr =
    t === 'sender_address' ? fallbackNormalize(id) : { normalized: id, local: null, domain: null };
  const suppressionId = ulid();

  const auditTierAdvance = await buildAuditInsert(env, {
    actor: 'system:sender-abuse-threshold',
    action: 'sender_abuse_profile.tier_advance',
    target: `${t}:${id}`,
    meta: {
      from_tier: profile.current_tier,
      to_tier: Math.min(profile.current_tier + 1, 5),
      weighted_24h: agg.weighted_24h,
      threshold: trigger,
      bypass: hasCritical,
    },
  });

  const auditSuppress = await buildAuditInsert(env, {
    actor: 'system:sender-abuse-threshold',
    action: 'sender.suppress_auto',
    target: `${t}:${id}`,
    meta: {
      suppression_id: suppressionId,
      tier_fired_from: profile.current_tier,
      duration_seconds: duration,
      expires_at: expiresAt,
      weighted_24h: agg.weighted_24h,
      event_count: agg.event_count,
      has_critical: hasCritical,
    },
  });

  const stmts = [
    env.DB.prepare(
      `INSERT INTO suppressions
         (id, entity_type, address_normalized, address_local, address_domain,
          scope, scope_target, reason, source, source_ref, severity,
          created_at, expires_at, disabled_at, disabled_reason, notes)
        VALUES (?, 'sender', ?, ?, ?, ?, ?, 'sender_abuse_threshold', 'sender_threshold_cron', NULL, 'critical', ?, ?, NULL, NULL, ?)
        ON CONFLICT DO NOTHING`,
    ).bind(
      suppressionId,
      addr.normalized,
      addr.local,
      addr.domain,
      scope,
      id,
      nowIso,
      expiresAt,
      hasCritical ? 'critical bypass: phishing/legal event present' : null,
    ),
    env.DB.prepare(
      `INSERT INTO sender_abuse_profile
         (principal_type, principal_id, lifetime_event_count, lifetime_weighted_score,
          suppression_count, current_tier, current_tier_started_at,
          last_suppressed_at, last_event_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(principal_type, principal_id) DO UPDATE SET
         lifetime_event_count = lifetime_event_count + ?,
         lifetime_weighted_score = lifetime_weighted_score + ?,
         suppression_count = suppression_count + 1,
         current_tier = MIN(current_tier + 1, 5),
         current_tier_started_at = ?,
         last_suppressed_at = ?,
         last_event_at = ?,
         updated_at = ?`,
    ).bind(
      t,
      id,
      agg.event_count,
      agg.weighted_24h,
      Math.min(profile.current_tier + 1, 5),
      nowIso,
      nowIso,
      agg.last_event_at,
      nowIso,
      nowIso,
      agg.event_count,
      agg.weighted_24h,
      nowIso,
      nowIso,
      agg.last_event_at,
      nowIso,
    ),
    auditTierAdvance.statement,
    auditSuppress.statement,
  ];
  await env.DB.batch(stmts);

  // Fire an admin alert (W2d) — best effort. We don't fail the cron run if
  // the alert pipeline trips because the suppression already landed.
  try {
    await sendAlert(env, {
      alert_type: hasCritical ? 'phishing_report_received' : 'sender_threshold_breached',
      severity: 'critical',
      target: `${t}:${id}`,
      subject: `[POLARIS][CRITICAL] sender suppressed: ${describeFor(t, id)}`,
      body:
        `Sender ${describeFor(t, id)} auto-suppressed at tier ${profile.current_tier} → ${Math.min(profile.current_tier + 1, 5)}.\n` +
        `weighted_24h=${agg.weighted_24h} (threshold ${trigger})\n` +
        `event_count=${agg.event_count}\n` +
        `critical_bypass=${hasCritical}\n` +
        `expires_at=${expiresAt ?? 'never (permanent)'}\n` +
        `suppression_id=${suppressionId}`,
      payload: {
        suppression_id: suppressionId,
        from_tier: profile.current_tier,
        to_tier: Math.min(profile.current_tier + 1, 5),
        weighted_24h: agg.weighted_24h,
        threshold: trigger,
        has_critical: hasCritical,
        expires_at: expiresAt,
      },
    });
  } catch {
    /* non-fatal */
  }

  return { fired: true, reason: 'suppressed' };
}

/**
 * Cron entrypoint. Idempotent: re-running within the same minute is safe.
 */
export async function senderAbuseThresholdRun(env: Env): Promise<{
  candidates: number;
  fired: number;
  details: Array<{
    principal_type: PrincipalType;
    principal_id: string;
    fired: boolean;
    reason: string;
  }>;
}> {
  const nowMs = Date.now();
  const sinceIso = new Date(nowMs - 24 * 3_600_000).toISOString();
  const details: Array<{
    principal_type: PrincipalType;
    principal_id: string;
    fired: boolean;
    reason: string;
  }> = [];
  let fired = 0;
  let candidates = 0;

  for (const t of ['sender_address', 'mailbox', 'domain'] as PrincipalType[]) {
    const aggs = await aggregateRecent(env, t, sinceIso);
    candidates += aggs.length;
    for (const a of aggs) {
      if (!a.principal_id) continue;
      const r = await fireOne(env, t, a.principal_id, a, nowMs);
      details.push({
        principal_type: t,
        principal_id: a.principal_id,
        fired: r.fired,
        reason: r.reason,
      });
      if (r.fired) fired++;
    }
  }
  return { candidates, fired, details };
}
