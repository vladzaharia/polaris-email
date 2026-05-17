// Stage 3 LLM tiebreaker — inbound-only.
//
// Mirrors the W2b triage.ts shape: optional env.AI binding, daily KV
// budget counter, JSON-mode response_format, fail-to-hold on error.
// Distinguishing features:
//   - Distinct KV budget key (policy:budget:YYYY-MM-DD) so the two AI
//     systems don't starve each other.
//   - Few-shot examples loaded from a KV-cached rolling window populated
//     by a daily cron from moderation_feedback.
//   - Returns an LlmOutcome that includes a `delta` the caller adds to
//     the heuristic score before re-banding.

import type { AiBinding, LlmOutcome, PolicyEnv, PolicyInput } from './types.js';
import { loadFeedbackExamples, type FeedbackExample } from './feedback.js';

const DEFAULT_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const DEFAULT_DAILY_BUDGET = 5000;
const DEFAULT_TIMEOUT_MS = 10_000;

const POLICY_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    label: {
      type: 'string',
      enum: ['phishing', 'malware', 'spam', 'marketing', 'legitimate'],
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string', maxLength: 500 },
  },
  required: ['label', 'confidence', 'rationale'],
  additionalProperties: false,
};

interface ParsedResponse {
  label: 'phishing' | 'malware' | 'spam' | 'marketing' | 'legitimate';
  confidence: number;
  rationale: string;
}

function isValidResponse(obj: unknown): obj is ParsedResponse {
  if (obj === null || typeof obj !== 'object') return false;
  const r = obj as Record<string, unknown>;
  return (
    typeof r.label === 'string' &&
    ['phishing', 'malware', 'spam', 'marketing', 'legitimate'].includes(r.label) &&
    typeof r.confidence === 'number' &&
    r.confidence >= 0 &&
    r.confidence <= 1 &&
    typeof r.rationale === 'string'
  );
}

const DEFAULT_PER_SECOND_BURST = 10;

async function checkBudget(env: PolicyEnv): Promise<{
  ok: boolean;
  key: string;
  current: number;
}> {
  const today = new Date().toISOString().slice(0, 10);
  const key = `policy:budget:${today}`;
  const current = Number((await env.KV.get(key)) ?? '0');
  const cap = Number(env.POLICY_AI_DAILY_BUDGET ?? '') || DEFAULT_DAILY_BUDGET;
  return { ok: current < cap, key, current };
}

/**
 * Per-second burst cap on the LLM call. The daily budget alone permits a
 * spike to exhaust the entire budget in seconds (e.g. a flood of inbound
 * mail). This second bucket smooths the curve so a steady-state day still
 * has budget left for the messages that actually need a tiebreaker. The
 * caller falls back to the heuristic verdict when this returns false.
 */
async function checkBurst(env: PolicyEnv): Promise<boolean> {
  const sec = Math.floor(Date.now() / 1000);
  const key = `policy:burst:${sec}`;
  const current = Number((await env.KV.get(key)) ?? '0');
  if (current >= DEFAULT_PER_SECOND_BURST) return false;
  await env.KV.put(key, String(current + 1), { expirationTtl: 10 });
  return true;
}

async function bumpBudget(env: PolicyEnv, key: string, current: number): Promise<void> {
  await env.KV.put(key, String(current + 1), { expirationTtl: 86_400 + 3_600 });
}

function buildFewShotBlock(examples: FeedbackExample[]): string {
  if (examples.length === 0) return '';
  const lines = examples.map((ex, i) => {
    const top = (ex.heuristic_reasons_summary ?? []).slice(0, 3).join(', ') || 'none';
    return `${i + 1}. SUBJECT: ${JSON.stringify(ex.message_summary).slice(0, 120)} / top signals: ${top} / admin verdict: ${ex.action}${ex.admin_notes ? ' (notes: ' + ex.admin_notes.slice(0, 80) + ')' : ''}`;
  });
  return [
    'Recent admin moderation decisions on similar messages (most recent first):',
    ...lines,
    '',
  ].join('\n');
}

function buildPrompt(input: PolicyInput, examples: FeedbackExample[]): string {
  const fewShot = buildFewShotBlock(examples);
  const headers = input.message.raw_headers.slice(0, 4000);
  const body = input.message.body_preview.slice(0, 4000);
  return [
    'You are an email policy classifier. Classify the email into one of:',
    'phishing | malware | spam | marketing | legitimate.',
    'Return JSON only: {label, confidence (0..1), rationale (<500 chars)}.',
    '',
    fewShot,
    '--- CURRENT MESSAGE ---',
    'HEADERS:',
    headers,
    '',
    'BODY PREVIEW:',
    body,
  ]
    .filter(Boolean)
    .join('\n');
}

function deltaFor(label: ParsedResponse['label'], confidence: number): number {
  if (label === 'phishing' && confidence >= 0.8) return -20;
  if (label === 'phishing' && confidence >= 0.5) return -12;
  if (label === 'malware' && confidence >= 0.8) return -20;
  if (label === 'spam' && confidence >= 0.6) return -10;
  if (label === 'marketing' && confidence >= 0.6) return -3;
  if (label === 'legitimate' && confidence >= 0.7) return 8;
  // Below confidence thresholds — no movement; heuristic verdict stands
  // (which for the uncertain band means 'hold' — admin moderates).
  return 0;
}

async function runWithTimeout(
  ai: AiBinding,
  model: string,
  prompt: string,
  timeoutMs: number,
): Promise<{ response?: string }> {
  return Promise.race([
    ai.run(model, {
      prompt,
      response_format: { type: 'json_schema', json_schema: POLICY_RESPONSE_JSON_SCHEMA },
      max_tokens: 512,
      temperature: 0.2,
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('policy LLM timeout')), timeoutMs),
    ),
  ]);
}

/**
 * Invoke the LLM tiebreaker for an inbound uncertain-band message.
 *
 * Fail-to-hold: any error / over-budget / parse failure returns
 * `budget_state != 'ok'` and delta=0; the caller keeps the heuristic
 * verdict (which for uncertain-band defaults to 'hold').
 */
export async function tiebreak(input: PolicyInput): Promise<LlmOutcome> {
  if (input.direction !== 'inbound') {
    return { invoked: false, budget_state: 'binding_absent' };
  }
  if (!input.env.AI) {
    return { invoked: false, budget_state: 'binding_absent' };
  }

  const budget = await checkBudget(input.env);
  if (!budget.ok) {
    return { invoked: false, budget_state: 'over_budget' };
  }
  if (!(await checkBurst(input.env))) {
    // Steady-state daily budget is fine, but we just hit the per-second
    // burst cap. Skip the LLM call and let the heuristic verdict stand.
    return { invoked: false, budget_state: 'over_budget' };
  }

  const examples = await loadFeedbackExamples(input.env.KV);
  const prompt = buildPrompt(input, examples);
  const model = input.env.POLICY_MODEL || DEFAULT_MODEL;
  const timeoutMs = Number(input.env.POLICY_AI_TIMEOUT_MS ?? '') || DEFAULT_TIMEOUT_MS;

  let raw: { response?: string };
  try {
    raw = await runWithTimeout(input.env.AI, model, prompt, timeoutMs);
  } catch (e) {
    return {
      invoked: true,
      budget_state: 'error',
      error: e instanceof Error ? e.message : 'unknown error',
    };
  }
  // Bump budget regardless of parse — the model spent inference time.
  await bumpBudget(input.env, budget.key, budget.current);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.response ?? '{}');
  } catch {
    return {
      invoked: true,
      budget_state: 'error',
      raw_response: raw.response,
      error: 'malformed JSON',
    };
  }
  if (!isValidResponse(parsed)) {
    return {
      invoked: true,
      budget_state: 'error',
      raw_response: raw.response,
      error: 'response failed schema validation',
    };
  }

  return {
    invoked: true,
    label: parsed.label,
    confidence: parsed.confidence,
    delta: deltaFor(parsed.label, parsed.confidence),
    budget_state: 'ok',
    raw_response: raw.response,
  };
}
