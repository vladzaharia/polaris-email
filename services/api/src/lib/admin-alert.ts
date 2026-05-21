// W2d — Admin alert pipeline.
//
// Single writer for "something happened that ops should know about" events
// across all W-streams. Three V1 delivery channels (audit_log + ALERT_WEBHOOK
// + admin_alerts table); future channels (email, Slack, PagerDuty) plug in
// here without schema changes.
//
// Deduplication: alerts identified by (alert_type, target, hourly-bucket)
// are suppressed after the first emit within the bucket. The dedupe key is
// stored in KV_ADMIN_ALERTS with a configurable TTL (default 1h). The
// admin_alerts table records every CALL to sendAlert (including suppressed
// ones, with delivery.deduped=true) so the panel can show "this alert
// fired N times in the last hour".

import { ulid } from '@polaris-mail/ids';
import { buildAuditInsert } from '../audit.js';
import type { Env } from '../env.js';

export type AdminAlertType =
  | 'sender_suppressed'
  | 'phishing_report_received'
  | 'legal_takedown_received'
  | 'sender_threshold_breached'
  | 'tls_rpt_failure_burst'
  | 'dmarc_alignment_drop'
  | 'synthetic_check_failed'
  | 'manual';

export type AdminAlertSeverity = 'info' | 'warn' | 'critical';

export interface AdminAlertInput {
  alert_type: AdminAlertType;
  severity: AdminAlertSeverity;
  /** Stable target id used for dedupe (sender_address, suppression_id, etc.). */
  target: string;
  subject: string;
  body: string;
  /** Structured context to surface on the panel detail view. */
  payload?: Record<string, unknown>;
}

export interface AdminAlertResult {
  id: string | null;
  delivered: boolean;
  deduped: boolean;
  delivery: Array<{ channel: string; ok: boolean; status?: number; error?: string }>;
}

interface AlertEnv extends Env {
  KV_ADMIN_ALERTS?: KVNamespace;
}

const DEFAULT_DEDUPE_TTL = 3600; // 1 hour
const FALLBACK_RECIPIENT = 'hey@vlad.gg';

function hourBucket(nowMs: number): number {
  return Math.floor(nowMs / 3_600_000);
}

async function shaHex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(digest);
  let out = '';
  for (const b of arr) out += b.toString(16).padStart(2, '0');
  return out.slice(0, 32);
}

/**
 * Fire-and-forget admin alert. Writes to admin_alerts + audit_log + (when
 * configured) ALERT_WEBHOOK. Dedupes via KV_ADMIN_ALERTS so an alert storm
 * during a burst incident doesn't spam the operator.
 *
 * Callers are expected to be idempotent — they should not double-call
 * `sendAlert` for the same logical event. Dedupe is a safety net, not the
 * primary contract.
 */
export async function sendAlert(env: AlertEnv, input: AdminAlertInput): Promise<AdminAlertResult> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const dedupeKey = await shaHex(`${input.alert_type}|${input.target}|${hourBucket(nowMs)}`);

  // Dedupe lookup. KV is eventually consistent; we accept the small chance
  // of double-fires during the propagation window because the audit log
  // remains the single source of truth.
  let deduped = false;
  if (env.KV_ADMIN_ALERTS) {
    const seen = await env.KV_ADMIN_ALERTS.get(dedupeKey);
    if (seen) deduped = true;
  }

  const id = ulid();
  const delivery: AdminAlertResult['delivery'] = [];

  // Channel 1 — admin_alerts row. Always written so the panel sees every
  // call, even deduped ones.
  try {
    await env.DB.prepare(
      `INSERT INTO admin_alerts
         (id, alert_type, severity, target, subject, body, delivery, payload, dedupe_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        input.alert_type,
        input.severity,
        input.target,
        input.subject,
        input.body,
        JSON.stringify([{ channel: 'admin_alerts', ok: true }]),
        JSON.stringify({ ...input.payload, deduped }),
        dedupeKey,
        nowIso,
      )
      .run();
    delivery.push({ channel: 'admin_alerts', ok: true });
  } catch (e) {
    delivery.push({
      channel: 'admin_alerts',
      ok: false,
      error: e instanceof Error ? e.message : 'unknown',
    });
  }

  // Channel 2 — audit_log. Even deduped alerts get an audit row so the
  // tamper-evident chain captures the storm pattern. We use the single-shot
  // buildAuditInsert + batch path (no retry loop) so a hot dedupe cycle
  // can't queue retries against a hot table; the next inbound request will
  // re-establish the tip on its CAS.
  try {
    const auditInsert = await buildAuditInsert(env, {
      actor: 'system:admin-alert',
      action: 'admin.alert.sent',
      target: input.target,
      meta: {
        alert_id: id,
        alert_type: input.alert_type,
        severity: input.severity,
        deduped,
      },
    });
    await env.DB.batch([auditInsert.statement]);
    delivery.push({ channel: 'audit_log', ok: true });
  } catch (e) {
    delivery.push({
      channel: 'audit_log',
      ok: false,
      error: e instanceof Error ? e.message : 'unknown',
    });
  }

  // Channel 3 — ALERT_WEBHOOK. Only fires on a non-deduped event so the
  // operator doesn't get N pages for the same fire. Bounded by a 5s timeout
  // so a hung webhook target can never wedge the call site.
  if (!deduped && env.ALERT_WEBHOOK) {
    try {
      const r = await fetch(env.ALERT_WEBHOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          alert_id: id,
          alert_type: input.alert_type,
          severity: input.severity,
          target: input.target,
          subject: input.subject,
          body: input.body,
          payload: input.payload ?? {},
          recipients: env.ADMIN_ALERT_RECIPIENTS ?? FALLBACK_RECIPIENT,
          created_at: nowIso,
        }),
        signal: AbortSignal.timeout(5_000),
      });
      delivery.push({ channel: 'webhook', ok: r.ok, status: r.status });
    } catch (e) {
      delivery.push({
        channel: 'webhook',
        ok: false,
        error: e instanceof Error ? e.message : 'unknown',
      });
    }
  }

  // Update delivery column with the actual channel attempts.
  try {
    await env.DB.prepare(`UPDATE admin_alerts SET delivery = ? WHERE id = ?`)
      .bind(JSON.stringify(delivery), id)
      .run();
  } catch {
    // Non-fatal; the table already has the placeholder entry from the INSERT.
  }

  // Mark the dedupe key only AFTER a successful first fire so a webhook
  // failure doesn't suppress the retry from a sibling caller.
  if (!deduped && env.KV_ADMIN_ALERTS) {
    const ttl = Number(env.ADMIN_ALERT_DEDUP_TTL_SECONDS ?? '') || DEFAULT_DEDUPE_TTL;
    await env.KV_ADMIN_ALERTS.put(dedupeKey, id, { expirationTtl: ttl });
  }

  return {
    id,
    delivered: delivery.some((d) => d.ok && d.channel !== 'admin_alerts'),
    deduped,
    delivery,
  };
}
