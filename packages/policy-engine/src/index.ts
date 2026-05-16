// Hybrid heuristics + LLM policy engine.
//
// Run `evaluatePolicy()` at both pipeline edges (services/in just before
// processMessage(), services/out just before binding.send()) to decide
// whether a message passes / passes-with-warning / holds for moderation /
// blocks outright. The engine is pure: callers persist the returned
// decision and apply downstream side-effects per the OUTCOME_DISPATCH
// table exported from ./dispatch.

export { evaluatePolicy } from './engine.js';
export { lookupOutcome, type Outcome, type OutcomeSpec } from './dispatch.js';
export { classifyBand, bandToVerdict, type Band } from './bands.js';
export { loadPolicyConfig } from './config.js';
export { tiebreak } from './llm.js';
export {
  recordModerationFeedback,
  refreshFeedbackWindow,
  loadFeedbackExamples,
  FEEDBACK_KV_KEY,
  type ModerationAction,
  type FeedbackExample,
  type RecordFeedbackInput,
} from './feedback.js';
export { INBOUND_HEURISTICS, OUTBOUND_HEURISTICS } from './heuristics/registry.js';
export type {
  AiBinding,
  AuthResults,
  D1,
  D1Stmt,
  Direction,
  Heuristic,
  HeuristicReason,
  KV,
  LlmOutcome,
  MessageCtx,
  PolicyBands,
  PolicyConfig,
  PolicyDecision,
  PolicyEnv,
  PolicyInput,
  ReasonCode,
  ReceiverCtx,
  SenderCtx,
  StreamType,
  Verdict,
} from './types.js';
export { DEFAULT_BANDS } from './types.js';
