// W2 — Complaint-mail ingest: parse ARF/DSN inbound emails delivered to the
// platform's postmaster@/abuse@/webmaster@ mailbox, write to abuse_events
// and (when actionable) to the suppression list.
//
// services/in/src/index.ts calls `handleComplaint()` when the resolved
// receiver's mailbox is the well-known `polaris-platform-complaints` row
// (id seeded by migration 0011). The function is side-effecting on D1 but
// has no fanout — the platform mailbox doesn't have webhook subscribers in
// the normal sense.

import {
  parseComplaint,
  suppressionTargets,
  type ParsedComplaint,
} from '@polaris-email/arf-parser';
import { normalizeAddress } from '@polaris-email/suppressions';
import { ulid } from '@polaris-email/ids';
import { triageUnstructuredComplaint, type TriageEnv } from './triage.js';

export const PLATFORM_COMPLAINTS_MAILBOX_ID = '01HXPLATFORMCOMPLAINTS0000';

// Minimal D1 surface to keep this module Worker-agnostic.
interface D1Stmt {
  bind(...params: unknown[]): D1Stmt;
  all<T = unknown>(): Promise<{ results: T[] }>;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<unknown>;
}
interface D1 {
  prepare(sql: string): D1Stmt;
  batch(statements: D1Stmt[]): Promise<unknown[]>;
}

export interface ComplaintIngestResult {
  classification: ParsedComplaint['kind'];
  abuseEventId: string | null;
  suppressionId: string | null;
  /** When the parser fell back to 'unstructured', this is set so the caller
   *  (W2b LLM triage) can pick the message up for classification. */
  needsLlmTriage: boolean;
}

/**
 * Lookup the sender principal triple (mailbox_id, sender_id, domain_id)
 * given a sender_address. Returns nulls for fields that can't be resolved
 * (e.g. complaints about a domain we don't own anymore).
 */
async function resolveSenderPrincipal(
  db: D1,
  senderAddress: string,
): Promise<{
  mailboxId: string | null;
  senderId: string | null;
  domainId: string | null;
}> {
  const normalized = senderAddress.toLowerCase().replace(/^<|>$/g, '');
  const senderRow = await db
    .prepare(
      `SELECT id, mailbox_id, domain_id FROM mailbox_senders WHERE LOWER(address) = ? LIMIT 1`,
    )
    .bind(normalized)
    .first<{ id: string; mailbox_id: string; domain_id: string }>();
  if (senderRow) {
    return {
      mailboxId: senderRow.mailbox_id,
      senderId: senderRow.id,
      domainId: senderRow.domain_id,
    };
  }
  // Fall back to domain-only matching when the sender_address isn't a
  // registered mailbox_senders row but we own the domain (e.g. for ad-hoc
  // sends or domain-wide complaints).
  const atIdx = normalized.lastIndexOf('@');
  if (atIdx < 0) return { mailboxId: null, senderId: null, domainId: null };
  const domain = normalized.slice(atIdx + 1);
  const domainRow = await db
    .prepare(`SELECT id FROM mail_domains WHERE name = ? LIMIT 1`)
    .bind(domain)
    .first<{ id: string }>();
  return {
    mailboxId: null,
    senderId: null,
    domainId: domainRow ? domainRow.id : null,
  };
}

/**
 * Insert an abuse_events row + optionally a suppression row, in one D1
 * batch so the two rows can never drift.
 */
async function writeAbuseAndSuppression(
  db: D1,
  args: {
    complaint: ParsedComplaint;
    classification: string;
    senderAddress: string | null;
    recipientAddress: string | null;
    suppressionReason: 'spam_complaint' | 'hard_bounce' | null;
    reporterAddress: string | null;
    reporterOrg: string | null;
    originalMessageId: string | null;
    source: 'arf_inbox' | 'llm_triage' | 'cf_bounce_webhook';
    weight: number;
  },
): Promise<{ abuseEventId: string; suppressionId: string | null }> {
  const eventId = ulid();
  const nowIso = new Date().toISOString();
  const principal = args.senderAddress
    ? await resolveSenderPrincipal(db, args.senderAddress)
    : { mailboxId: null, senderId: null, domainId: null };

  // Recipient-side suppression (only fires when we have a clean recipient
  // address and a known reason). Sender-side suppressions are driven by W2c
  // threshold logic, NOT directly by this single event.
  let suppressionId: string | null = null;
  const recipNormalized = args.recipientAddress ? normalizeAddress(args.recipientAddress) : null;
  const stmts: D1Stmt[] = [];

  if (recipNormalized && args.suppressionReason) {
    suppressionId = ulid();
    stmts.push(
      db
        .prepare(
          `INSERT INTO suppressions
             (id, entity_type, address_normalized, address_local, address_domain,
              scope, scope_target, reason, source, source_ref, severity,
              created_at, expires_at, disabled_at, disabled_reason, notes)
            VALUES (?, 'recipient', ?, ?, ?, 'global', NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
            ON CONFLICT DO NOTHING`,
        )
        .bind(
          suppressionId,
          recipNormalized.normalized,
          recipNormalized.local,
          recipNormalized.domain,
          args.suppressionReason,
          args.source,
          eventId,
          args.suppressionReason === 'spam_complaint' ? 'critical' : 'warn',
          nowIso,
        ),
    );
  }

  stmts.push(
    db
      .prepare(
        `INSERT INTO abuse_events
           (id, sender_address,
            sender_principal_mailbox_id, sender_principal_sender_id,
            sender_principal_domain_id,
            classification, source, source_ref, weight,
            reporter_address, reporter_org, original_message_id,
            raw_meta, caused_suppression_id, reported_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        eventId,
        args.senderAddress,
        principal.mailboxId,
        principal.senderId,
        principal.domainId,
        args.classification,
        args.source,
        args.weight,
        args.reporterAddress,
        args.reporterOrg,
        args.originalMessageId,
        JSON.stringify(args.complaint),
        suppressionId,
        nowIso,
        nowIso,
      ),
  );

  await db.batch(stmts);
  return { abuseEventId: eventId, suppressionId };
}

/**
 * Top-level handler invoked from services/in/src/index.ts when an inbound
 * message resolves to the platform complaints mailbox.
 *
 * When `triageEnv` is provided, unstructured complaints fan out to W2b
 * Workers-AI triage *in addition* to the bare abuse_events log. Callers
 * without an AI binding (CI, smoke scripts) may pass undefined; the
 * unstructured-complaint path still records the sparse abuse_events row.
 */
export async function handleComplaint(
  db: D1,
  rawMime: Uint8Array,
  reporterAddress: string | null,
  triageEnv?: TriageEnv,
): Promise<ComplaintIngestResult> {
  const raw = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(rawMime);
  const complaint = parseComplaint(raw);

  if (complaint.kind === 'unstructured') {
    // Surface for W2b LLM triage. We still write a sparse abuse_events row
    // tagged 'other' so an operator can later see the volume of unstructured
    // complaints flowing in — but no suppression fires yet.
    const result = await writeAbuseAndSuppression(db, {
      complaint,
      classification: 'other',
      senderAddress: null,
      recipientAddress: null,
      suppressionReason: null,
      reporterAddress: complaint.from ?? reporterAddress,
      reporterOrg: null,
      originalMessageId: null,
      source: 'arf_inbox',
      weight: 0,
    });
    // W2b — Workers AI triage when the env was wired. The LLM may flip an
    // unstructured complaint into a real suppression when confidence is high
    // enough; otherwise it just logs into triage_events for human review.
    let triagedSuppressionId: string | null = null;
    if (triageEnv) {
      try {
        const tri = await triageUnstructuredComplaint(triageEnv, {
          rawHeaders: raw.slice(0, Math.min(raw.length, 8000)),
          bodyPreview: complaint.bodyPreview,
          inboundAlias: reporterAddress,
          sourceMessageId: null,
        });
        triagedSuppressionId = tri.appliedSuppressionId;
      } catch {
        // W2b is best-effort — never block W2 ingest on its failure.
      }
    }
    return {
      classification: 'unstructured',
      abuseEventId: result.abuseEventId,
      suppressionId: triagedSuppressionId,
      needsLlmTriage: !triageEnv || !triagedSuppressionId,
    };
  }

  if (complaint.kind === 'arf') {
    const targets = suppressionTargets(complaint);
    const classification = (() => {
      switch (complaint.feedbackType) {
        case 'abuse':
          return 'spam_complaint';
        case 'fraud':
          return 'phishing_report';
        case 'virus':
          return 'virus';
        case 'auth-failure':
          return 'auth_failure';
        case 'opt-out':
          return 'opt_out';
        default:
          return 'other';
      }
    })();
    const weight = classification === 'phishing_report' ? 5 : 1;
    const result = await writeAbuseAndSuppression(db, {
      complaint,
      classification,
      senderAddress: targets.senderAddress,
      recipientAddress: targets.recipientAddress,
      suppressionReason: targets.reason,
      reporterAddress: reporterAddress,
      reporterOrg: complaint.userAgent ?? complaint.reportingMta,
      originalMessageId: complaint.originalMessageId,
      source: 'arf_inbox',
      weight,
    });
    return {
      classification: 'arf',
      abuseEventId: result.abuseEventId,
      suppressionId: result.suppressionId,
      needsLlmTriage: false,
    };
  }

  // DSN
  const targets = suppressionTargets(complaint);
  const result = await writeAbuseAndSuppression(db, {
    complaint,
    classification: complaint.permanent ? 'hard_bounce' : 'other',
    senderAddress: null, // DSNs don't carry our sender; W3 webhook will fill this in.
    recipientAddress: targets.recipientAddress,
    suppressionReason: targets.reason,
    reporterAddress: reporterAddress,
    reporterOrg: complaint.reportingMta,
    originalMessageId: null,
    source: 'arf_inbox',
    weight: 1,
  });
  return {
    classification: 'dsn',
    abuseEventId: result.abuseEventId,
    suppressionId: result.suppressionId,
    needsLlmTriage: false,
  };
}
