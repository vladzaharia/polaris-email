// W2b — LLM-assisted triage of unstructured complaint mail.
//
// Invoked from services/in/src/complaint-ingest.ts when the deterministic
// ARF/DSN parser falls through to `kind=unstructured`. Invokes Workers AI
// in JSON-mode, validates the response against the shared
// TriageClassification Zod schema, writes a triage_events row, and
// dispatches the configured action (suppression / log-only).
//
// Budget guardrail: every call increments a daily KV counter under
// `triage:budget:YYYY-MM-DD`. When the day's count exceeds
// env.TRIAGE_DAILY_BUDGET (default 5000), further calls fall through to
// a log-only triage_events row without invoking the model.

import {
  buildTriagePrompt,
  TriageClassification,
  TRIAGE_RESPONSE_JSON_SCHEMA,
  type TriageCategory,
} from '@polaris-mail/triage-schema';
import { normalizeAddress } from '@polaris-mail/suppressions';
import { ulid } from '@polaris-mail/ids';

const DEFAULT_DAILY_BUDGET = 5000;
const DEFAULT_MODEL = '@cf/meta/llama-3.1-8b-instruct';

interface D1Stmt {
  bind(...params: unknown[]): D1Stmt;
  run(): Promise<unknown>;
}
interface D1 {
  prepare(sql: string): D1Stmt;
  batch(statements: D1Stmt[]): Promise<unknown[]>;
}
interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export interface TriageEnv {
  DB: D1;
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
  KV_IDEMPOTENCY?: KV;
  TRIAGE_DAILY_BUDGET?: string;
  TRIAGE_MODEL?: string;
}

export interface TriageInput {
  rawHeaders: string;
  bodyPreview: string;
  inboundAlias: string | null;
  sourceMessageId: string | null;
}

export interface TriageOutput {
  triageEventId: string;
  category: TriageCategory;
  actionable: boolean;
  confidence: number;
  appliedSuppressionId: string | null;
  budgetExceeded: boolean;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const arr = new Uint8Array(buf);
  let hex = '';
  for (const b of arr) hex += b.toString(16).padStart(2, '0');
  return hex;
}

async function checkBudget(env: TriageEnv): Promise<{ ok: boolean; key: string; current: number }> {
  if (!env.KV_IDEMPOTENCY) return { ok: true, key: '', current: 0 };
  const today = new Date().toISOString().slice(0, 10);
  const key = `triage:budget:${today}`;
  const current = Number((await env.KV_IDEMPOTENCY.get(key)) ?? '0');
  const cap = Number(env.TRIAGE_DAILY_BUDGET ?? '') || DEFAULT_DAILY_BUDGET;
  return { ok: current < cap, key, current };
}

async function bumpBudget(env: TriageEnv, key: string, current: number): Promise<void> {
  if (!env.KV_IDEMPOTENCY || !key) return;
  await env.KV_IDEMPOTENCY.put(key, String(current + 1), { expirationTtl: 86_400 + 3_600 });
}

async function writeLogOnlyRow(
  env: TriageEnv,
  promptHash: string,
  input: TriageInput,
  modelLabel: string,
  responsePayload: Record<string, unknown>,
  summary: string,
): Promise<TriageOutput> {
  const id = ulid();
  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO triage_events
       (id, message_id, inbound_alias, model, prompt_hash, response_json,
        category, severity, confidence, actionable, target_recipient,
        target_sender_principal, target_message_id, summary,
        applied_suppression_id, operator_verdict, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'noise', 'info', 0, 0, NULL, NULL, NULL, ?, NULL, NULL, ?)`,
  )
    .bind(
      id,
      input.sourceMessageId,
      input.inboundAlias,
      modelLabel,
      promptHash,
      JSON.stringify(responsePayload),
      summary,
      nowIso,
    )
    .run();
  return {
    triageEventId: id,
    category: 'noise',
    actionable: false,
    confidence: 0,
    appliedSuppressionId: null,
    budgetExceeded: modelLabel === 'budget-exceeded',
  };
}

export async function triageUnstructuredComplaint(
  env: TriageEnv,
  input: TriageInput,
): Promise<TriageOutput> {
  const prompt = buildTriagePrompt({
    rawHeaders: input.rawHeaders,
    bodyPreview: input.bodyPreview,
    rcpt: input.inboundAlias ?? undefined,
  });
  const promptHash = await sha256Hex(prompt);

  // Budget gate.
  const budget = await checkBudget(env);
  if (!budget.ok) {
    return writeLogOnlyRow(
      env,
      promptHash,
      input,
      'budget-exceeded',
      { budget_exceeded: true },
      'Daily Workers AI budget exhausted — logged without classification.',
    );
  }
  if (!env.AI) {
    return writeLogOnlyRow(
      env,
      promptHash,
      input,
      'ai-binding-absent',
      { reason: 'ai_binding_absent' },
      'Workers AI binding not configured — logged without classification.',
    );
  }

  const model = env.TRIAGE_MODEL || DEFAULT_MODEL;
  let raw: { response?: string };
  try {
    raw = await env.AI.run(model, {
      prompt,
      response_format: { type: 'json_schema', json_schema: TRIAGE_RESPONSE_JSON_SCHEMA },
      max_tokens: 512,
      temperature: 0.2,
    });
  } catch (e) {
    return writeLogOnlyRow(
      env,
      promptHash,
      input,
      model,
      { error: e instanceof Error ? e.message : 'unknown' },
      'LLM invocation failed — logged without classification.',
    );
  }
  await bumpBudget(env, budget.key, budget.current);

  let parsed: ReturnType<typeof TriageClassification.parse>;
  try {
    parsed = TriageClassification.parse(JSON.parse(raw.response ?? '{}'));
  } catch (e) {
    return writeLogOnlyRow(
      env,
      promptHash,
      input,
      model,
      { raw_response: raw.response, parse_error: e instanceof Error ? e.message : 'unknown' },
      'LLM response failed schema validation — logged without classification.',
    );
  }

  // Dispatch: fire a recipient suppression for actionable spam/phishing with
  // high enough confidence AND an extractable recipient. Below 0.6 confidence
  // → log only (panel surfaces for human review).
  let appliedSuppressionId: string | null = null;
  const stmts: D1Stmt[] = [];
  const id = ulid();
  const nowIso = new Date().toISOString();
  const fireRecipientSuppression =
    parsed.actionable &&
    parsed.confidence >= 0.6 &&
    (parsed.category === 'spam_complaint' || parsed.category === 'phishing_report') &&
    parsed.target_recipient != null;
  if (fireRecipientSuppression && parsed.target_recipient) {
    const norm = normalizeAddress(parsed.target_recipient);
    if (norm) {
      appliedSuppressionId = ulid();
      const reason = parsed.category === 'phishing_report' ? 'phishing_report' : 'spam_complaint';
      stmts.push(
        env.DB.prepare(
          `INSERT INTO suppressions
             (id, entity_type, address_normalized, address_local, address_domain,
              scope, scope_target, reason, source, source_ref, severity,
              created_at, expires_at, disabled_at, disabled_reason, notes)
            VALUES (?, 'recipient', ?, ?, ?, 'global', NULL, ?, 'llm_triage', ?, ?, ?, NULL, NULL, NULL, NULL)
            ON CONFLICT DO NOTHING`,
        ).bind(
          appliedSuppressionId,
          norm.normalized,
          norm.local,
          norm.domain,
          reason,
          id,
          parsed.severity === 'critical' ? 'critical' : 'warn',
          nowIso,
        ),
      );
    }
  }

  stmts.push(
    env.DB.prepare(
      `INSERT INTO triage_events
         (id, message_id, inbound_alias, model, prompt_hash, response_json,
          category, severity, confidence, actionable, target_recipient,
          target_sender_principal, target_message_id, summary,
          applied_suppression_id, operator_verdict, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).bind(
      id,
      input.sourceMessageId,
      input.inboundAlias,
      model,
      promptHash,
      JSON.stringify(parsed),
      parsed.category,
      parsed.severity,
      parsed.confidence,
      parsed.actionable ? 1 : 0,
      parsed.target_recipient ?? null,
      parsed.target_sender_principal ?? null,
      parsed.target_message_id ?? null,
      parsed.summary,
      appliedSuppressionId,
      nowIso,
    ),
  );

  await env.DB.batch(stmts);

  return {
    triageEventId: id,
    category: parsed.category,
    actionable: parsed.actionable,
    confidence: parsed.confidence,
    appliedSuppressionId,
    budgetExceeded: false,
  };
}
