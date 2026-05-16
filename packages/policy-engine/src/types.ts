// Public types for the hybrid policy engine.
//
// The engine is a pure function: callers pass a fully resolved context
// (headers + body preview + sender/receiver lookups already performed) and
// receive a verdict + reason vector. Side-effects (suppression writes,
// held_messages inserts, admin alerts, re-injection) belong to the caller.

export type Direction = 'inbound' | 'outbound';

export type StreamType = 'transactional' | 'marketing' | 'agent' | 'inbound';

/** Verdict the engine returns. Maps to outcomes per OUTCOME_DISPATCH. */
export type Verdict = 'pass' | 'pass_warn' | 'hold' | 'block';

/** Stable reason code emitted by an individual heuristic. */
export type ReasonCode = string;

export interface HeuristicReason {
  reason_code: ReasonCode;
  score: number;
  evidence: string;
}

export interface LlmOutcome {
  invoked: boolean;
  label?: 'phishing' | 'malware' | 'spam' | 'marketing' | 'legitimate';
  confidence?: number;
  delta?: number;
  budget_state: 'ok' | 'over_budget' | 'binding_absent' | 'error';
  raw_response?: string;
  error?: string;
}

export interface PolicyDecision {
  verdict: Verdict;
  total_score: number;
  reasons: HeuristicReason[];
  llm: LlmOutcome;
  /** Caller persists this row and threads its id into downstream side-effects. */
  decision_id: string;
  /** Per-direction band breakdown so the caller can render explainers. */
  band: 'pass' | 'pass_warn' | 'uncertain' | 'hold' | 'block_decisive';
}

/** Parsed auth-results header values the engine reads. */
export interface AuthResults {
  spf?: 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror';
  dkim?: {
    result: 'pass' | 'fail' | 'none' | 'policy' | 'neutral' | 'temperror' | 'permerror';
    /** `d=` parameter when the signature parsed. */
    signing_domain?: string;
  };
  dmarc?: 'pass' | 'fail' | 'none';
  /** DMARC policy advertised by the From-domain at evaluation time. */
  dmarc_policy?: 'none' | 'quarantine' | 'reject';
}

/** Minimal D1-like surface the engine queries. Worker-agnostic. */
export interface D1Stmt {
  bind(...params: unknown[]): D1Stmt;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface D1 {
  prepare(sql: string): D1Stmt;
}

/** Subset of the KV namespace API we use for the LLM budget + few-shot cache. */
export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** Workers AI binding shape — mirrors what services/in already imports. */
export interface AiBinding {
  run(
    model: string,
    input: {
      prompt?: string;
      messages?: Array<{ role: string; content: string }>;
      response_format?: { type: 'json_schema'; json_schema: unknown };
      max_tokens?: number;
      temperature?: number;
    },
  ): Promise<{ response?: string }>;
}

export interface PolicyEnv {
  DB: D1;
  KV: KV;
  AI?: AiBinding;
  POLICY_MODEL?: string;
  POLICY_AI_DAILY_BUDGET?: string;
  POLICY_AI_TIMEOUT_MS?: string;
  MODERATION_FEEDBACK_WINDOW_SIZE?: string;
  /** Soak-mode flag. When `false`, outbound block/hold downgrades to pass_warn. */
  POLICY_ENGINE_OUTBOUND_FULL?: string;
}

/** Bands derived from policy_config; defaults applied when not overridden. */
export interface PolicyBands {
  pass_min: number;
  pass_warn_max: number;
  uncertain_max: number;
  hold_max: number;
}

export const DEFAULT_BANDS: PolicyBands = {
  pass_min: 0,
  pass_warn_max: -1,
  uncertain_max: -5,
  hold_max: -15,
};

/** Per-domain / per-mailbox config (loaded via packages/policy-engine/config). */
export interface PolicyConfig {
  bands: PolicyBands;
  /** Optional per-heuristic score overrides. Engine multiplies/adds at sum time. */
  weights: Record<ReasonCode, number>;
}

export interface SenderCtx {
  /** When the sender is one of our principals (outbound or known-correspondent). */
  principal_id?: string;
  mailbox_id?: string;
  domain_id?: string;
  /** Raw `From:` address. */
  address: string;
  /** Display name parsed out of `From:`. */
  display_name?: string;
  /** Sender-abuse tier from W2c. 0 = clean / unknown. */
  abuse_tier?: number;
  /** DMARC promotion state for the sender domain (outbound only). */
  dmarc_promotion_state?:
    | 'none'
    | 'quarantine_ready'
    | 'quarantine'
    | 'reject_ready'
    | 'reject'
    | 'paused';
}

export interface ReceiverCtx {
  /** Envelope-To we resolved to. */
  address: string;
  /** Receiver's mailbox_id when it's one of ours (inbound). */
  mailbox_id?: string;
  /** Receiver's domain_id when known. */
  domain_id?: string;
}

export interface MessageCtx {
  /** Raw headers as a single string (CRLF-joined). */
  raw_headers: string;
  /** Map of normalized header name (lowercase) → value(s). First-seen value if duplicated. */
  headers: Record<string, string>;
  /** First ~4000 chars of the body for cheap inspection + LLM input. */
  body_preview: string;
  /** Body content-types observed (e.g. `['text/html', 'application/zip']`). */
  content_types: string[];
  /** Attachment filenames (when MIME parser surfaced them). */
  attachment_filenames: string[];
  /** Header_message_id of the original this message replies to, if any. */
  in_reply_to_message_id?: string;
  /** True when the body has an HTML part with no text/plain alternative. */
  html_only?: boolean;
}

export interface PolicyInput {
  direction: Direction;
  stream_type: StreamType;
  sender: SenderCtx;
  receiver: ReceiverCtx;
  message: MessageCtx;
  auth: AuthResults;
  env: PolicyEnv;
  /** Optional pre-computed config; engine loads from D1 if omitted. */
  config?: PolicyConfig;
}

/** Each heuristic implements this shape. Returns null to abstain. */
export type Heuristic = (
  input: PolicyInput,
) => HeuristicReason | null | Promise<HeuristicReason | null>;
