// Verdict × direction × stream → outcome mapping.
//
// Lives as plain data so callers (services/in, services/out) can render
// helpful errors/responses without re-deriving the table. Pure data — no
// side-effects here; the caller actually applies the outcome.

import type { Direction, StreamType, Verdict } from './types.js';

export type Outcome =
  | 'deliver'
  | 'deliver_with_warning_header'
  | 'send'
  | 'send_with_warning'
  | 'send_with_caller_warning'
  | 'queue_for_moderation'
  | 'bounce_with_reasons'
  | 'drop_with_forensic_row';

export interface OutcomeSpec {
  outcome: Outcome;
  /** Whether to fire an admin alert via W2d sendAlert(). */
  alert: boolean;
  /** Admin-alert severity to pass to sendAlert(). */
  alert_severity: 'info' | 'warn' | 'critical';
  /** Whether to credit the sender's W2c abuse profile (outbound marketing block). */
  credit_sender_abuse: boolean;
}

type DispatchKey = `${Direction}:${StreamType}:${Verdict}`;

const ENTRY = (spec: OutcomeSpec): OutcomeSpec => spec;

const TABLE: Partial<Record<DispatchKey, OutcomeSpec>> = {
  // Inbound — stream_type is collapsed to 'inbound' by the caller.
  'inbound:inbound:pass': ENTRY({
    outcome: 'deliver',
    alert: false,
    alert_severity: 'info',
    credit_sender_abuse: false,
  }),
  'inbound:inbound:pass_warn': ENTRY({
    outcome: 'deliver_with_warning_header',
    alert: false,
    alert_severity: 'info',
    credit_sender_abuse: false,
  }),
  'inbound:inbound:hold': ENTRY({
    outcome: 'queue_for_moderation',
    alert: true,
    alert_severity: 'warn',
    credit_sender_abuse: false,
  }),
  'inbound:inbound:block': ENTRY({
    outcome: 'drop_with_forensic_row',
    alert: true,
    alert_severity: 'critical',
    credit_sender_abuse: false,
  }),

  // Outbound transactional.
  'outbound:transactional:pass': ENTRY({
    outcome: 'send',
    alert: false,
    alert_severity: 'info',
    credit_sender_abuse: false,
  }),
  'outbound:transactional:pass_warn': ENTRY({
    outcome: 'send_with_warning',
    alert: false,
    alert_severity: 'info',
    credit_sender_abuse: false,
  }),
  'outbound:transactional:hold': ENTRY({
    outcome: 'queue_for_moderation',
    alert: true,
    alert_severity: 'warn',
    credit_sender_abuse: false,
  }),
  'outbound:transactional:block': ENTRY({
    outcome: 'bounce_with_reasons',
    alert: true,
    alert_severity: 'critical',
    credit_sender_abuse: false,
  }),

  // Outbound marketing — block credits sender abuse profile.
  'outbound:marketing:pass': ENTRY({
    outcome: 'send',
    alert: false,
    alert_severity: 'info',
    credit_sender_abuse: false,
  }),
  'outbound:marketing:pass_warn': ENTRY({
    outcome: 'send_with_warning',
    alert: false,
    alert_severity: 'info',
    credit_sender_abuse: false,
  }),
  'outbound:marketing:hold': ENTRY({
    outcome: 'queue_for_moderation',
    alert: true,
    alert_severity: 'warn',
    credit_sender_abuse: false,
  }),
  'outbound:marketing:block': ENTRY({
    outcome: 'bounce_with_reasons',
    alert: true,
    alert_severity: 'critical',
    credit_sender_abuse: true,
  }),

  // Outbound agent — block is escalated (LLM hallucination signal).
  'outbound:agent:pass': ENTRY({
    outcome: 'send',
    alert: false,
    alert_severity: 'info',
    credit_sender_abuse: false,
  }),
  'outbound:agent:pass_warn': ENTRY({
    outcome: 'send_with_caller_warning',
    alert: false,
    alert_severity: 'info',
    credit_sender_abuse: false,
  }),
  'outbound:agent:hold': ENTRY({
    outcome: 'queue_for_moderation',
    alert: true,
    alert_severity: 'warn',
    credit_sender_abuse: false,
  }),
  'outbound:agent:block': ENTRY({
    outcome: 'bounce_with_reasons',
    alert: true,
    alert_severity: 'critical',
    credit_sender_abuse: false,
  }),
};

/**
 * Look up the outcome for a (direction, stream_type, verdict) tuple.
 *
 * `stream_type` is normalized — anything inbound collapses to 'inbound'
 * because there is no inbound stream_type axis from the caller's POV.
 */
export function lookupOutcome(
  direction: Direction,
  stream_type: StreamType,
  verdict: Verdict,
): OutcomeSpec {
  const normalizedStream: StreamType = direction === 'inbound' ? 'inbound' : stream_type;
  const key: DispatchKey = `${direction}:${normalizedStream}:${verdict}`;
  const hit = TABLE[key];
  if (!hit) {
    throw new Error(`policy-engine: no dispatch entry for ${key}`);
  }
  return hit;
}
