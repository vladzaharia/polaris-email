// Moderation-feedback primitives.
//
// Two responsibilities:
//   1. recordModerationFeedback(): write a moderation_feedback row when an
//      admin acts on a held message.
//   2. loadFeedbackExamples(): read the KV-cached rolling window of recent
//      decisions used as few-shot examples in the inbound LLM prompt.
//
// The KV cache is populated by a daily cron in services/api/src/scheduled/
// feedback-window-refresh.ts. That cron is the only writer to the KV key;
// individual moderation actions don't write KV inline (avoids race-y
// double-writes; cron is the single source of truth for "what the model
// is being primed with right now").

import type { D1, KV } from './types.js';

export type ModerationAction =
  | 'released_as_legit'
  | 'dropped_as_phishing'
  | 'dropped_as_spam'
  | 'dropped_as_marketing'
  | 'reclassified';

export interface FeedbackExample {
  id: string;
  decision_id: string;
  admin_id: string;
  action: ModerationAction;
  original_verdict: string;
  corrected_verdict: string | null;
  message_summary: string;
  heuristic_reasons_summary: string[];
  llm_label_at_decision: string | null;
  llm_confidence_at_decision: number | null;
  admin_notes: string | null;
  created_at: string;
}

const KV_KEY = 'policy:feedback_examples';
const DEFAULT_WINDOW_SIZE = 20;

interface ModerationFeedbackRow {
  id: string;
  decision_id: string;
  message_id: string | null;
  admin_id: string;
  action: ModerationAction;
  original_verdict: string;
  corrected_verdict: string | null;
  message_summary: string;
  heuristic_reasons_summary: string; // JSON-encoded array
  llm_label_at_decision: string | null;
  llm_confidence_at_decision: number | null;
  admin_notes: string | null;
  created_at: string;
}

function rowToExample(row: ModerationFeedbackRow): FeedbackExample {
  let reasons: string[] = [];
  try {
    const parsed = JSON.parse(row.heuristic_reasons_summary);
    if (Array.isArray(parsed)) reasons = parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    // Leave empty.
  }
  return {
    id: row.id,
    decision_id: row.decision_id,
    admin_id: row.admin_id,
    action: row.action,
    original_verdict: row.original_verdict,
    corrected_verdict: row.corrected_verdict,
    message_summary: row.message_summary,
    heuristic_reasons_summary: reasons,
    llm_label_at_decision: row.llm_label_at_decision,
    llm_confidence_at_decision: row.llm_confidence_at_decision,
    admin_notes: row.admin_notes,
    created_at: row.created_at,
  };
}

export interface RecordFeedbackInput {
  decision_id: string;
  message_id: string | null;
  admin_id: string;
  action: ModerationAction;
  original_verdict: string;
  corrected_verdict?: string;
  message_summary: string;
  heuristic_reasons_summary: string[];
  llm_label_at_decision?: string;
  llm_confidence_at_decision?: number;
  admin_notes?: string;
}

export async function recordModerationFeedback(
  db: D1,
  id: string,
  input: RecordFeedbackInput,
): Promise<void> {
  const nowIso = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO moderation_feedback
         (id, decision_id, message_id, admin_id, action, original_verdict,
          corrected_verdict, message_summary, heuristic_reasons_summary,
          llm_label_at_decision, llm_confidence_at_decision, admin_notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.decision_id,
      input.message_id,
      input.admin_id,
      input.action,
      input.original_verdict,
      input.corrected_verdict ?? null,
      input.message_summary.slice(0, 400),
      JSON.stringify(input.heuristic_reasons_summary.slice(0, 3)),
      input.llm_label_at_decision ?? null,
      input.llm_confidence_at_decision ?? null,
      input.admin_notes ?? null,
      nowIso,
    )
    .run();
}

export async function loadFeedbackExamples(kv: KV): Promise<FeedbackExample[]> {
  const raw = await kv.get(KV_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is FeedbackExample =>
        v && typeof v === 'object' && typeof (v as FeedbackExample).id === 'string',
    );
  } catch {
    return [];
  }
}

export async function refreshFeedbackWindow(
  db: D1,
  kv: KV,
  windowSize: number = DEFAULT_WINDOW_SIZE,
): Promise<number> {
  const result = await db
    .prepare(
      `SELECT id, decision_id, message_id, admin_id, action, original_verdict,
              corrected_verdict, message_summary, heuristic_reasons_summary,
              llm_label_at_decision, llm_confidence_at_decision, admin_notes, created_at
         FROM moderation_feedback
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .bind(windowSize)
    .all<ModerationFeedbackRow>();
  const examples = result.results.map(rowToExample);
  await kv.put(KV_KEY, JSON.stringify(examples), { expirationTtl: 86_400 * 2 });
  return examples.length;
}

export const FEEDBACK_KV_KEY = KV_KEY;
