// Daily cron — snapshots the most-recent N moderation_feedback rows into
// the KV-cached few-shot window the inbound policy LLM reads from.
//
// Why a cron and not inline on each moderation action: the LLM prompt
// builder reads the KV key on every uncertain-band inbound message;
// keeping that key under cron control means there's exactly one writer,
// no race conditions, and a bounded refresh latency (≤24h) the operator
// can reason about. If an admin needs the window refreshed immediately
// after a moderation decision, the panel exposes a "Force refresh"
// button that calls refreshFeedbackWindow() directly.
//
// Reuses packages/policy-engine/src/feedback.ts as the single source of
// truth for the KV key + serialisation shape — that way the writer and
// the reader can never disagree.

import { refreshFeedbackWindow } from '@polaris-mail/policy-engine';
import type { Env } from '../env.js';

const DEFAULT_WINDOW_SIZE = 20;

export async function feedbackWindowRefresh(env: Env): Promise<{ written: number }> {
  const size = Number(env.MODERATION_FEEDBACK_WINDOW_SIZE ?? '') || DEFAULT_WINDOW_SIZE;
  const written = await refreshFeedbackWindow(env.DB, env.KV_IDEMPOTENCY, size);
  return { written };
}
