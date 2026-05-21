// Wire the policy engine into the inbound Email Routing handler.
//
// Runs immediately before processMessage(). Stages 1+2+3 — the Stage 3
// LLM tiebreaker is invoked when heuristics land in the uncertain band
// AND env.AI is bound. Fail-to-hold on any LLM error (admin moderates).
//
// Dispatch:
//   pass       → caller proceeds with processMessage() unchanged
//   pass_warn  → caller proceeds; policy_decisions row records the warning
//   hold       → MIME stored in R2 under held/<decision_id>, held_messages
//                row inserted, processMessage NOT called, no fanout
//   block      → MIME stored in R2 under blocked/<decision_id> as forensic
//                evidence, processMessage NOT called, no fanout
//
// The original messageId from processMessage() is NOT minted for hold/block
// because we never call processMessage. The held_messages row stores the
// raw R2 key directly; the panel moderation page surfaces these without
// needing a messages row to point at. On release, the moderation endpoint
// re-injects via processMessage() and the message row materialises then.

import { evaluatePolicy } from '@polaris-mail/policy-engine';
import type {
  Direction,
  PolicyDecision,
  PolicyInput,
  StreamType,
} from '@polaris-mail/policy-engine';
import { parseStrict, type ParsedMime } from '@polaris-mail/mime';
import { ulid } from '@polaris-mail/ids';

// We only depend on a narrow slice of the services/in Env — pass it in via
// the function signature so this module stays Worker-agnostic.
interface InboundPolicyEnv {
  DB: D1Database;
  R2: R2Bucket;
  KV_IDEMPOTENCY?: KVNamespace;
  // Mirror services/in's AI shape (mandatory `prompt: string`) for
  // assignability — the engine's AiBinding has `prompt?: string` but the
  // engine always passes a prompt at runtime so the looser shape is safe.
  AI?: {
    run(
      model: string,
      args: {
        prompt: string;
        response_format?: { type: string; json_schema?: unknown };
        max_tokens?: number;
        temperature?: number;
      },
    ): Promise<{ response?: string }>;
  };
  POLICY_MODEL?: string;
  POLICY_AI_DAILY_BUDGET?: string;
  POLICY_AI_TIMEOUT_MS?: string;
}

export interface InboundPolicyInput {
  mailboxId: string;
  domainId: string | null;
  envelopeFrom: string;
  envelopeTo: string;
  rawMime: Uint8Array;
  // Matches the flat shape from packages/mime parseAuthResults — verdicts
  // are bare strings, not objects. The engine accepts a richer shape
  // (DKIM signing_domain etc.), but for inbound we only have the bare
  // result without per-signature detail unless we re-parse the
  // Authentication-Results header ourselves.
  authResults: {
    spf?: string;
    dkim?: string;
    dmarc?: string;
  };
}

import {
  headersMap,
  rawHeadersString,
  bodyPreviewOf as bodyPreview,
  asSpf,
  asDkimResult,
  asDmarc,
} from '@polaris-mail/policy-engine/mime-helpers';

async function persistDecision(
  env: InboundPolicyEnv,
  messageId: string | null,
  decision: PolicyDecision,
): Promise<void> {
  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO policy_decisions
       (id, message_id, direction, stream_type, verdict, total_score,
        heuristic_reasons_json, llm_invoked, llm_label, llm_confidence,
        llm_budget_state, decided_at)
     VALUES (?, ?, 'inbound', 'inbound', ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      decision.decision_id,
      messageId,
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
}

async function storeRawMime(
  env: InboundPolicyEnv,
  rawMime: Uint8Array,
  prefix: 'held' | 'blocked',
  decisionId: string,
): Promise<string> {
  const key = `policy_${prefix}/${decisionId}.eml`;
  await env.R2.put(key, rawMime);
  return key;
}

async function insertHeldMessage(
  env: InboundPolicyEnv,
  decision: PolicyDecision,
  rawR2Key: string,
): Promise<string> {
  const id = ulid();
  const nowIso = new Date().toISOString();
  const holdUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO held_messages
       (id, message_id, direction, stream_type, decision_id, raw_mime_r2_key,
        hold_reason, hold_until, created_at)
     VALUES (?, NULL, 'inbound', 'inbound', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
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

export type InboundPolicyAction =
  | { kind: 'continue'; decision: PolicyDecision }
  | { kind: 'hold'; decision: PolicyDecision; hold_id: string; r2_key: string }
  | { kind: 'block'; decision: PolicyDecision; r2_key: string };

/**
 * Run the engine against an inbound message. Returns the action the
 * caller should take. The caller is responsible for either calling
 * processMessage() (continue) or just returning early (hold/block).
 */
export async function evaluateInboundPolicy(
  env: InboundPolicyEnv,
  input: InboundPolicyInput,
): Promise<InboundPolicyAction> {
  let parsed: ParsedMime;
  try {
    parsed = parseStrict(input.rawMime);
  } catch {
    // Malformed inbound MIME — fail-closed by holding. The forensic copy
    // lets an operator inspect what slipped past CF Email Routing's own
    // validation. This is rare but real.
    const synthetic: PolicyDecision = {
      verdict: 'hold',
      total_score: -999,
      reasons: [
        {
          reason_code: 'mime_parse_error',
          score: -999,
          evidence: 'Inbound MIME failed parseStrict — engine cannot inspect',
        },
      ],
      llm: { invoked: false, budget_state: 'binding_absent' },
      decision_id: `pd_${ulid()}`,
      band: 'hold',
    };
    await persistDecision(env, null, synthetic);
    const r2Key = await storeRawMime(env, input.rawMime, 'held', synthetic.decision_id);
    const hold_id = await insertHeldMessage(env, synthetic, r2Key);
    return { kind: 'hold', decision: synthetic, hold_id, r2_key: r2Key };
  }

  const headers = headersMap(parsed);
  const policyInput: PolicyInput = {
    direction: 'inbound' as Direction,
    stream_type: 'inbound' as StreamType,
    sender: { address: input.envelopeFrom },
    receiver: {
      address: input.envelopeTo,
      mailbox_id: input.mailboxId,
      domain_id: input.domainId ?? undefined,
    },
    message: {
      raw_headers: rawHeadersString(parsed),
      headers,
      body_preview: bodyPreview(parsed),
      content_types: [headers['content-type'] ?? ''].filter(Boolean),
      attachment_filenames: [],
    },
    auth: {
      spf: asSpf(input.authResults.spf),
      dkim: input.authResults.dkim
        ? { result: asDkimResult(input.authResults.dkim) ?? 'none' }
        : undefined,
      dmarc: asDmarc(input.authResults.dmarc),
      // dmarc_policy isn't surfaced by parseAuthResults; the dmarc_reject
      // heuristic skips when policy is unknown, which is the safe default.
      dmarc_policy: undefined,
    },
    env: {
      DB: env.DB as unknown as PolicyInput['env']['DB'],
      KV: env.KV_IDEMPOTENCY
        ? {
            get: (k: string) => env.KV_IDEMPOTENCY!.get(k),
            put: (k: string, v: string, opts?: { expirationTtl?: number }) =>
              env.KV_IDEMPOTENCY!.put(k, v, opts),
          }
        : { get: async () => null, put: async () => undefined },
      AI: env.AI as unknown as PolicyInput['env']['AI'],
      POLICY_MODEL: env.POLICY_MODEL,
      POLICY_AI_DAILY_BUDGET: env.POLICY_AI_DAILY_BUDGET,
      POLICY_AI_TIMEOUT_MS: env.POLICY_AI_TIMEOUT_MS,
    },
  };

  let decision: PolicyDecision;
  try {
    decision = await evaluatePolicy(policyInput);
  } catch (e) {
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

  switch (decision.verdict) {
    case 'pass':
    case 'pass_warn':
      // Defer policy_decisions row until processMessage() returns the
      // messageId so the FK lands populated. Caller persists.
      return { kind: 'continue', decision };
    case 'hold': {
      await persistDecision(env, null, decision);
      const r2Key = await storeRawMime(env, input.rawMime, 'held', decision.decision_id);
      const hold_id = await insertHeldMessage(env, decision, r2Key);
      return { kind: 'hold', decision, hold_id, r2_key: r2Key };
    }
    case 'block': {
      await persistDecision(env, null, decision);
      const r2Key = await storeRawMime(env, input.rawMime, 'blocked', decision.decision_id);
      return { kind: 'block', decision, r2_key: r2Key };
    }
    default: {
      // Exhaustive-check fallthrough — verdict union is closed.
      const _exhaustive: never = decision.verdict;
      throw new Error(`unhandled verdict: ${_exhaustive as string}`);
    }
  }
}

/**
 * Persist the policy_decisions row for a pass/pass_warn after the
 * message row exists. Threads the message_id through so the FK is
 * populated. Idempotent against repeated calls because policy_decisions
 * has a primary key on its own id.
 */
export async function attachDecisionToMessage(
  env: InboundPolicyEnv,
  decision: PolicyDecision,
  messageId: string,
): Promise<void> {
  await persistDecision(env, messageId, decision);
  await env.DB.prepare(`UPDATE messages SET policy_decision_id = ? WHERE id = ?`)
    .bind(decision.decision_id, messageId)
    .run();
}
