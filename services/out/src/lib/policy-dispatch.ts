// Wire the policy engine into the outbound queue consumer.
//
// Runs AFTER the W1 suppression check passes (so W1 can short-circuit
// cheaply for obviously-banned senders/recipients) but BEFORE the actual
// binding.send() call. Outbound never invokes the Stage 3 LLM
// tiebreaker — services/out has no AI binding by design (cost). The
// engine's outbound path goes Stages 1+2 only; uncertain band routes
// straight to 'hold'.
//
// Held messages stay in D1 with status='held', a row in held_messages
// pointing at the existing R2 MIME blob, and the policy_decisions row
// recording why. The panel moderation queue drives release/drop.
// The original POST /v1/messages 202 message_id doubles as the future
// hold_id — no synchronous API surface change needed.
//
// Soak mode: when POLICY_ENGINE_OUTBOUND_FULL is unset or 'false',
// 'block' and 'hold' verdicts downgrade to 'pass_warn' (decision still
// recorded so an operator can review what *would have* been blocked).
// Flip the flag to 'true' after the 7-day P2 soak.

import { evaluatePolicy, lookupOutcome } from '@polaris-mail/policy-engine';
import type {
  Direction,
  PolicyDecision,
  PolicyInput,
  StreamType,
} from '@polaris-mail/policy-engine';
import { parseStrict, type ParsedMime } from '@polaris-mail/mime';
import { ulid } from '@polaris-mail/ids';
import type { Env, OutboundQueueMessage } from '../env.js';

interface MessageRow {
  stream_type: string;
  principal_id: string | null;
  mailbox_id: string;
}

interface SenderAbuseRow {
  current_tier: number;
}

interface DomainRow {
  id: string;
  name: string;
  dmarc_promotion_state: string | null;
}

function asStreamType(value: string | null | undefined): StreamType {
  if (value === 'marketing' || value === 'agent' || value === 'inbound') return value;
  return 'transactional';
}

function asPromotionState(
  value: string | null,
): 'none' | 'quarantine_ready' | 'quarantine' | 'reject_ready' | 'reject' | 'paused' | undefined {
  if (
    value === 'none' ||
    value === 'quarantine_ready' ||
    value === 'quarantine' ||
    value === 'reject_ready' ||
    value === 'reject' ||
    value === 'paused'
  ) {
    return value;
  }
  return undefined;
}

import {
  headersMap,
  rawHeadersString,
  bodyPreviewOf,
} from '@polaris-mail/policy-engine/mime-helpers';

function isSoakActive(env: Env): boolean {
  return (
    (env as Env & { POLICY_ENGINE_OUTBOUND_FULL?: string }).POLICY_ENGINE_OUTBOUND_FULL !== 'true'
  );
}

async function loadMessageRow(env: Env, messageId: string): Promise<MessageRow | null> {
  const stmt = env.DB.prepare(
    `SELECT stream_type, principal_id, mailbox_id FROM messages WHERE id = ? LIMIT 1`,
  ).bind(messageId);
  return (await stmt.first()) as MessageRow | null;
}

async function loadAbuseTier(env: Env, senderAddress: string): Promise<number> {
  // sender_abuse_profile is keyed by (principal_type, principal_id) per
  // migration 0013. For sender_address-scoped tier we look up by
  // normalised address.
  const stmt = env.DB.prepare(
    `SELECT current_tier FROM sender_abuse_profile
      WHERE principal_type='sender_address'
        AND principal_id = ?
      LIMIT 1`,
  ).bind(senderAddress.toLowerCase());
  const row = (await stmt.first()) as SenderAbuseRow | null;
  return row?.current_tier ?? 0;
}

async function loadDomain(env: Env, domainId: string | null): Promise<DomainRow | null> {
  if (!domainId) return null;
  return (await env.DB.prepare(
    `SELECT id, name, dmarc_promotion_state FROM mail_domains WHERE id = ? LIMIT 1`,
  )
    .bind(domainId)
    .first()) as DomainRow | null;
}

async function persistDecision(
  env: Env,
  msg: OutboundQueueMessage,
  streamType: StreamType,
  decision: PolicyDecision,
): Promise<void> {
  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO policy_decisions
       (id, message_id, direction, stream_type, verdict, total_score,
        heuristic_reasons_json, llm_invoked, llm_label, llm_confidence,
        llm_budget_state, decided_at)
     VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      decision.decision_id,
      msg.messageId,
      streamType,
      decision.verdict,
      decision.total_score,
      JSON.stringify(decision.reasons),
      decision.llm.invoked ? 1 : 0,
      decision.llm.label ?? null,
      decision.llm.confidence ?? null,
      decision.llm.budget_state,
      nowIso,
    )
    .run();
  await env.DB.prepare(`UPDATE messages SET policy_decision_id = ? WHERE id = ?`)
    .bind(decision.decision_id, msg.messageId)
    .run();
}

async function insertHeldMessage(
  env: Env,
  msg: OutboundQueueMessage,
  streamType: StreamType,
  decision: PolicyDecision,
  rawR2Key: string,
): Promise<string> {
  const id = ulid();
  const nowIso = new Date().toISOString();
  // Default hold-until: 7 days from now. Per-domain auto_release / auto_drop
  // is configurable later via policy_config; for V1 we default-drop on expiry
  // via the janitor cron (separate sweep — not part of this PR).
  const holdUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO held_messages
       (id, message_id, direction, stream_type, decision_id, raw_mime_r2_key,
        hold_reason, hold_until, created_at)
     VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      msg.messageId,
      streamType,
      decision.decision_id,
      rawR2Key,
      decision.reasons
        .map((r: { reason_code: string; score: number }) => `${r.reason_code}=${r.score}`)
        .slice(0, 5)
        .join(','),
      holdUntil,
      nowIso,
    )
    .run();
  return id;
}

export type PolicyAction =
  | { kind: 'continue'; decision: PolicyDecision }
  | { kind: 'hold'; decision: PolicyDecision; hold_id: string }
  | { kind: 'block'; decision: PolicyDecision };

/**
 * Run the engine, persist the decision + held row when applicable, and
 * tell the caller what to do. Caller is responsible for setting message
 * status and firing the appropriate fanout event.
 */
export async function evaluateOutboundPolicy(
  env: Env,
  msg: OutboundQueueMessage,
  rawMime: Uint8Array,
  domainId: string | null,
): Promise<PolicyAction> {
  let parsed: ParsedMime;
  try {
    parsed = parseStrict(rawMime);
  } catch {
    // If the caller's MIME is malformed the engine can't meaningfully
    // judge it — fail-closed by holding. The W1 path already would have
    // bounced earlier in pipeline for obvious garbage.
    const synthetic: PolicyDecision = {
      verdict: 'hold',
      total_score: -999,
      reasons: [
        {
          reason_code: 'mime_parse_error',
          score: -999,
          evidence: 'Outbound MIME failed parseStrict — policy engine cannot inspect',
        },
      ],
      llm: { invoked: false, budget_state: 'binding_absent' },
      decision_id: `pd_${ulid()}`,
      band: 'hold',
    };
    await persistDecision(env, msg, 'transactional', synthetic);
    const hold_id = await insertHeldMessage(
      env,
      msg,
      'transactional',
      synthetic,
      msg.r2KeyOrInline,
    );
    return { kind: 'hold', decision: synthetic, hold_id };
  }

  const messageRow = await loadMessageRow(env, msg.messageId);
  const streamType = asStreamType(messageRow?.stream_type);
  const abuseTier = await loadAbuseTier(env, msg.fromAddress);
  const domain = await loadDomain(env, domainId);

  const input: PolicyInput = {
    direction: 'outbound' as Direction,
    stream_type: streamType,
    sender: {
      address: msg.fromAddress,
      mailbox_id: msg.mailboxId,
      domain_id: domainId ?? undefined,
      principal_id: messageRow?.principal_id ?? undefined,
      abuse_tier: abuseTier,
      dmarc_promotion_state: asPromotionState(domain?.dmarc_promotion_state ?? null),
    },
    receiver: {
      // For policy purposes use the first recipient. Per-recipient
      // suppression is W1's job; the engine evaluates the message as a
      // whole.
      address: msg.envelopeTo && msg.envelopeTo.length > 0 ? msg.envelopeTo[0]! : msg.fromAddress,
    },
    message: {
      raw_headers: rawHeadersString(parsed),
      headers: headersMap(parsed),
      body_preview: bodyPreviewOf(parsed),
      content_types: [headersMap(parsed)['content-type'] ?? ''].filter(Boolean),
      attachment_filenames: [],
    },
    auth: {},
    env: {
      DB: env.DB as unknown as PolicyInput['env']['DB'],
      KV: { get: async () => null, put: async () => undefined },
      // No AI binding on services/out by design — outbound is heuristic-only.
    },
  };

  let decision: PolicyDecision;
  try {
    decision = await evaluatePolicy(input);
  } catch (e) {
    // Engine itself threw — fail-closed by holding.
    decision = {
      verdict: 'hold',
      total_score: -999,
      reasons: [
        {
          reason_code: 'engine_error',
          score: -999,
          evidence: `Policy engine threw: ${e instanceof Error ? e.message : 'unknown'}`,
        },
      ],
      llm: { invoked: false, budget_state: 'binding_absent' },
      decision_id: `pd_${ulid()}`,
      band: 'hold',
    };
  }

  await persistDecision(env, msg, streamType, decision);

  // Soak mode: downgrade block/hold to pass_warn so the engine can't break
  // legitimate outbound during the first week. Decision row is still
  // recorded so an operator can review what would have been blocked.
  const effective: PolicyDecision = isSoakActive(env)
    ? decision.verdict === 'pass' || decision.verdict === 'pass_warn'
      ? decision
      : { ...decision, verdict: 'pass_warn' }
    : decision;

  // Dispatch on the (possibly soak-downgraded) verdict.
  const spec = lookupOutcome('outbound', streamType, effective.verdict);
  switch (spec.outcome) {
    case 'send':
    case 'send_with_warning':
    case 'send_with_caller_warning':
      return { kind: 'continue', decision: effective };
    case 'queue_for_moderation': {
      const hold_id = await insertHeldMessage(env, msg, streamType, effective, msg.r2KeyOrInline);
      return { kind: 'hold', decision: effective, hold_id };
    }
    case 'bounce_with_reasons':
      return { kind: 'block', decision: effective };
    default:
      // Unexpected outcome for outbound — be safe and hold.
      return {
        kind: 'hold',
        decision: effective,
        hold_id: await insertHeldMessage(env, msg, streamType, effective, msg.r2KeyOrInline),
      };
  }
}
