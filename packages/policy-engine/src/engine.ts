// The pure evaluatePolicy() function.
//
// Stages:
//   1. Iterate the per-direction heuristic registry, sum signed scores.
//   2. Classify via bands.
//   3. (inbound only, uncertain band only) invoke the LLM tiebreaker;
//      add its delta; re-classify.
//
// Returns the verdict + reason vector + decision_id. The CALLER persists
// the row, threads its id into downstream side-effects (suppression
// writes, held_messages inserts, admin alerts).

import { classifyBand, bandToVerdict, type Band } from './bands.js';
import { loadPolicyConfig } from './config.js';
import { tiebreak } from './llm.js';
import { INBOUND_HEURISTICS, OUTBOUND_HEURISTICS } from './heuristics/registry.js';
import type {
  HeuristicReason,
  LlmOutcome,
  PolicyConfig,
  PolicyDecision,
  PolicyInput,
  ReasonCode,
} from './types.js';
import { DEFAULT_BANDS } from './types.js';

function makeDecisionId(): string {
  // Borrow Crockford-ULID shape from packages/ids without taking a dep
  // (we don't have @polaris-email/ids in this workspace's deps and the
  // engine should remain dep-light). Random-only is fine since the caller
  // can swap to ulid() at insert time if it prefers timestamp ordering.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `pd_${hex}`;
}

function applyWeightOverride(
  reason: HeuristicReason,
  overrides: Record<ReasonCode, number>,
): HeuristicReason {
  const override = overrides[reason.reason_code];
  if (override === undefined) return reason;
  // Override semantics: replace the score wholesale. Lets operators
  // disable a heuristic by setting it to 0, or amplify by raising the
  // magnitude. The original sign is preserved by the override value.
  return { ...reason, score: override };
}

async function runHeuristics(input: PolicyInput, config: PolicyConfig): Promise<HeuristicReason[]> {
  const registry = input.direction === 'inbound' ? INBOUND_HEURISTICS : OUTBOUND_HEURISTICS;
  const reasons: HeuristicReason[] = [];
  for (const h of registry) {
    let r: HeuristicReason | null;
    try {
      const out = h(input);
      r = out instanceof Promise ? await out : out;
    } catch (e) {
      // A throwing heuristic is a bug — record it as a synthetic reason
      // so the engine still returns a decision (fail-closed: caller will
      // see a 'hold' verdict from the surfacing reason_code below).
      reasons.push({
        reason_code: 'heuristic_error',
        score: -10,
        evidence: `Heuristic threw: ${e instanceof Error ? e.message : 'unknown'}`,
      });
      continue;
    }
    if (r) reasons.push(applyWeightOverride(r, config.weights));
  }
  return reasons;
}

/**
 * The engine. Pure (no D1 writes; only reads via the heuristics + config
 * loader). Caller is responsible for persisting the returned decision and
 * threading `decision_id` into downstream side-effects.
 */
export async function evaluatePolicy(input: PolicyInput): Promise<PolicyDecision> {
  const config: PolicyConfig =
    input.config ??
    (await loadPolicyConfig(input.env.DB, {
      domain_id: input.receiver.domain_id,
      mailbox_id: input.receiver.mailbox_id,
    }).catch(() => ({ bands: DEFAULT_BANDS, weights: {} })));

  const reasons = await runHeuristics(input, config);
  const heuristicScore = reasons.reduce((sum, r) => sum + r.score, 0);
  const heuristicBand = classifyBand(heuristicScore, config.bands);

  let llm: LlmOutcome = { invoked: false, budget_state: 'binding_absent' };
  let finalScore = heuristicScore;
  let finalBand: Band = heuristicBand;

  if (input.direction === 'inbound' && heuristicBand === 'uncertain') {
    llm = await tiebreak(input);
    if (llm.invoked && typeof llm.delta === 'number' && llm.budget_state === 'ok') {
      finalScore = heuristicScore + llm.delta;
      finalBand = classifyBand(finalScore, config.bands);
    }
    // If the LLM failed / over-budget / binding absent in the uncertain
    // band, bandToVerdict('uncertain') returns 'hold' — admin moderates.
  }

  const verdict = bandToVerdict(finalBand, input.direction);

  return {
    verdict,
    total_score: finalScore,
    reasons,
    llm,
    decision_id: makeDecisionId(),
    band: finalBand,
  };
}
