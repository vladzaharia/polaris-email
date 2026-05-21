// 0019 — Admin REST over the policy_decisions + held_messages tables.
//
// Reads:
//   GET  /v1/admin/policy/decisions             — paginated list
//   GET  /v1/admin/policy/decisions/:id         — detail (heuristic vector + LLM result)
//   GET  /v1/admin/policy/held                  — paginated held queue
//   GET  /v1/admin/policy/held/:id              — single held message + its decision
//
// Actions (each writes a moderation_feedback row that feeds the inbound
// LLM few-shot window via the daily KV-refresh cron):
//   POST /v1/admin/policy/held/:id/release      { action, notes? }
//   POST /v1/admin/policy/held/:id/drop         { action, notes? }
//   POST /v1/admin/policy/held/:id/reclassify   { corrected_verdict, notes? }
//
// Release semantics:
//   - Inbound held → re-inject the stored R2 MIME via processMessage()
//     using the original receiver mailbox. Today the held_messages row
//     doesn't preserve the original receiver address, so release just
//     marks released_action='released' and an operator must manually
//     forward. A future migration that adds recipient_mailbox_id to
//     held_messages will let release re-inject end-to-end.
//   - Outbound held → re-enqueue to OUTBOUND_QUEUE so services/out
//     sends normally on the next attempt. The messages row is bumped
//     back to status='queued'.
//
// Drop semantics: just mark released_action='dropped'. The MIME blob in
// R2 stays for forensic-window TTL (cleaned up by janitor cron later).
import { Hono } from 'hono';
import { ulid } from '@polaris-mail/ids';
import { recordModerationFeedback, type ModerationAction } from '@polaris-mail/policy-engine';
import { bodyText, requireScope } from '../../auth.js';
import { audit } from '../../audit.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const moderation = new Hono<{ Bindings: Env }>();

interface PolicyDecisionRow {
  id: string;
  message_id: string | null;
  direction: string;
  stream_type: string;
  verdict: string;
  total_score: number;
  heuristic_reasons_json: string;
  llm_invoked: number;
  llm_label: string | null;
  llm_confidence: number | null;
  llm_budget_state: string | null;
  decided_at: string;
  override_decision_id: string | null;
  override_admin_id: string | null;
  override_reason: string | null;
}

interface HeldMessageRow {
  id: string;
  message_id: string | null;
  direction: string;
  stream_type: string;
  decision_id: string;
  raw_mime_r2_key: string;
  hold_reason: string;
  hold_until: string;
  released_at: string | null;
  released_by: string | null;
  released_action: string | null;
  created_at: string;
}

const DECISION_COLS =
  'id, message_id, direction, stream_type, verdict, total_score, ' +
  'heuristic_reasons_json, llm_invoked, llm_label, llm_confidence, ' +
  'llm_budget_state, decided_at, override_decision_id, override_admin_id, override_reason';

const HELD_COLS =
  'id, message_id, direction, stream_type, decision_id, raw_mime_r2_key, ' +
  'hold_reason, hold_until, released_at, released_by, released_action, created_at';

// ---------- list / detail (read) ----------

moderation.get('/v1/admin/policy/decisions', requireScope('admin:read'), async (c) => {
  const verdict = c.req.query('verdict');
  const direction = c.req.query('direction');
  const streamType = c.req.query('stream_type');
  const since = c.req.query('since');
  // `message_id` lets MessageDetail pull the single decision for this message
  // without scanning hundreds of unrelated rows. Most messages have ≤1
  // decision, so the response is a list-of-one in practice.
  const messageId = c.req.query('message_id');
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '100'), 1), 500);

  const where: string[] = [];
  const binds: unknown[] = [];
  if (verdict) {
    where.push('verdict = ?');
    binds.push(verdict);
  }
  if (direction) {
    where.push('direction = ?');
    binds.push(direction);
  }
  if (streamType) {
    where.push('stream_type = ?');
    binds.push(streamType);
  }
  if (since) {
    where.push('decided_at >= ?');
    binds.push(since);
  }
  if (messageId) {
    where.push('message_id = ?');
    binds.push(messageId);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT ${DECISION_COLS} FROM policy_decisions ${clause}
               ORDER BY decided_at DESC LIMIT ?`;
  binds.push(limit);
  const out = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all<PolicyDecisionRow>();
  return c.json({ data: out.results });
});

moderation.get('/v1/admin/policy/decisions/:id', requireScope('admin:read'), async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(`SELECT ${DECISION_COLS} FROM policy_decisions WHERE id = ?`)
    .bind(id)
    .first<PolicyDecisionRow>();
  if (!row) return buildError(c, 'not_found', 'no such policy_decision');
  return c.json(row);
});

moderation.get('/v1/admin/policy/held', requireScope('admin:read'), async (c) => {
  const direction = c.req.query('direction');
  const status = c.req.query('status') ?? 'open'; // open | released | dropped | all
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '100'), 1), 500);

  const where: string[] = [];
  const binds: unknown[] = [];
  if (direction) {
    where.push('direction = ?');
    binds.push(direction);
  }
  if (status === 'open') where.push('released_action IS NULL');
  else if (status !== 'all') {
    where.push('released_action = ?');
    binds.push(status);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT ${HELD_COLS} FROM held_messages ${clause}
               ORDER BY created_at DESC LIMIT ?`;
  binds.push(limit);
  const out = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all<HeldMessageRow>();
  return c.json({ data: out.results });
});

moderation.get('/v1/admin/policy/held/:id', requireScope('admin:read'), async (c) => {
  const id = c.req.param('id');
  const held = await c.env.DB.prepare(`SELECT ${HELD_COLS} FROM held_messages WHERE id = ?`)
    .bind(id)
    .first<HeldMessageRow>();
  if (!held) return buildError(c, 'not_found', 'no such held_message');
  const decision = await c.env.DB.prepare(
    `SELECT ${DECISION_COLS} FROM policy_decisions WHERE id = ?`,
  )
    .bind(held.decision_id)
    .first<PolicyDecisionRow>();
  return c.json({ held, decision });
});

// ---------- moderation actions ----------

interface ActionBody {
  action?: ModerationAction;
  notes?: string;
  corrected_verdict?: string;
}

function parseBody(text: string): ActionBody | null {
  if (!text) return {};
  try {
    return JSON.parse(text) as ActionBody;
  } catch {
    return null;
  }
}

function summarise(reasonsJson: string): { summary: string; top_reasons: string[] } {
  try {
    const parsed = JSON.parse(reasonsJson) as { reason_code: string; score: number }[];
    return {
      summary: parsed
        .map((r) => `${r.reason_code}(${r.score})`)
        .slice(0, 5)
        .join(', '),
      top_reasons: parsed.map((r) => r.reason_code).slice(0, 3),
    };
  } catch {
    return { summary: '(unparseable reasons)', top_reasons: [] };
  }
}

async function loadHeldOrFail(env: Env, id: string): Promise<HeldMessageRow | null> {
  const held = await env.DB.prepare(`SELECT ${HELD_COLS} FROM held_messages WHERE id = ?`)
    .bind(id)
    .first<HeldMessageRow>();
  if (!held) return null;
  if (held.released_action) return null; // already actioned
  return held;
}

async function loadDecision(env: Env, decisionId: string): Promise<PolicyDecisionRow | null> {
  return await env.DB.prepare(`SELECT ${DECISION_COLS} FROM policy_decisions WHERE id = ?`)
    .bind(decisionId)
    .first<PolicyDecisionRow>();
}

async function applyMarkReleased(
  env: Env,
  id: string,
  adminId: string,
  status: 'released' | 'dropped',
): Promise<void> {
  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE held_messages SET released_at = ?, released_by = ?, released_action = ?
       WHERE id = ?`,
  )
    .bind(nowIso, adminId, status, id)
    .run();
}

async function recordFeedback(
  env: Env,
  held: HeldMessageRow,
  decision: PolicyDecisionRow,
  adminId: string,
  action: ModerationAction,
  notes: string | undefined,
  correctedVerdict: string | undefined,
): Promise<void> {
  const reasons = summarise(decision.heuristic_reasons_json);
  await recordModerationFeedback(c_env_db(env), ulid(), {
    decision_id: decision.id,
    message_id: held.message_id,
    admin_id: adminId,
    action,
    original_verdict: decision.verdict,
    corrected_verdict: correctedVerdict,
    message_summary: reasons.summary,
    heuristic_reasons_summary: reasons.top_reasons,
    llm_label_at_decision: decision.llm_label ?? undefined,
    llm_confidence_at_decision: decision.llm_confidence ?? undefined,
    admin_notes: notes,
  });
}

// Thin shim to bridge services/api's D1Database to the policy-engine D1
// surface (which is structurally identical but typed independently).
function c_env_db(env: Env): Parameters<typeof recordModerationFeedback>[0] {
  return env.DB as unknown as Parameters<typeof recordModerationFeedback>[0];
}

moderation.post('/v1/admin/policy/held/:id/release', requireScope('admin:write'), async (c) => {
  const id = c.req.param('id');
  const body = parseBody(bodyText(c));
  if (body === null) return buildError(c, 'bad_request', 'invalid JSON');
  const action: ModerationAction =
    body.action && (body.action === 'released_as_legit' || body.action === 'reclassified')
      ? body.action
      : 'released_as_legit';
  const held = await loadHeldOrFail(c.env, id);
  if (!held)
    return buildError(
      c,
      'not_found',
      'held message not actionable (missing or already released/dropped)',
    );
  const decision = await loadDecision(c.env, held.decision_id);
  if (!decision) return buildError(c, 'not_found', 'decision missing for held message');

  const apiKey = c.get('apiKey');
  const adminId = apiKey?.principal_id ?? 'unknown';

  // For outbound held → flip the message row back to queued and re-enqueue.
  // For inbound held → we don't have the original receiver mailbox in the
  // held_messages row (the engine deferred row-creation until release).
  // V1 release for inbound just marks the row; future enhancement would
  // re-inject via processMessage(). Document the gap explicitly.
  if (held.direction === 'outbound' && held.message_id) {
    await c.env.DB.prepare(`UPDATE messages SET status = 'queued', last_error = NULL WHERE id = ?`)
      .bind(held.message_id)
      .run();
    if (c.env.OUTBOUND_QUEUE) {
      // Look up the message row to reconstruct the queue body.
      const mrow = await c.env.DB.prepare(
        `SELECT id, from_addr, mailbox_id, r2_key,
                (SELECT name FROM mail_domains WHERE id = (SELECT zone_id FROM mailboxes WHERE id = messages.mailbox_id LIMIT 1)) AS domain_name,
                (SELECT id   FROM mail_domains WHERE id = (SELECT zone_id FROM mailboxes WHERE id = messages.mailbox_id LIMIT 1)) AS domain_id,
                to_addrs
           FROM messages WHERE id = ?`,
      )
        .bind(held.message_id)
        .first<{
          id: string;
          from_addr: string;
          mailbox_id: string;
          r2_key: string;
          domain_name: string | null;
          domain_id: string | null;
          to_addrs: string | null;
        }>();
      if (mrow) {
        const envelopeTo = mrow.to_addrs ? (JSON.parse(mrow.to_addrs) as string[]) : undefined;
        // domain_name from the join above may be NULL on edge cases — fall
        // back to extracting the from_addr's domain so the queue body has
        // a binding name to dispatch against.
        const fromDomain =
          mrow.domain_name ?? mrow.from_addr.slice(mrow.from_addr.lastIndexOf('@') + 1);
        await c.env.OUTBOUND_QUEUE.send({
          messageId: mrow.id,
          source: 'raw',
          r2KeyOrInline: mrow.r2_key,
          fromDomain,
          fromAddress: mrow.from_addr,
          envelopeTo,
          mailboxId: mrow.mailbox_id,
          domainId: mrow.domain_id,
          mode: 'live',
        });
      }
    }
  }

  await applyMarkReleased(c.env, id, adminId, 'released');
  await recordFeedback(c.env, held, decision, adminId, action, body.notes, body.corrected_verdict);
  await audit(c.env, {
    actor: adminId,
    action: 'message.held_release',
    target: held.id,
    meta: { decision_id: decision.id, direction: held.direction },
  });
  return c.json({ ok: true, held_id: held.id, released: true });
});

moderation.post('/v1/admin/policy/held/:id/drop', requireScope('admin:write'), async (c) => {
  const id = c.req.param('id');
  const body = parseBody(bodyText(c));
  if (body === null) return buildError(c, 'bad_request', 'invalid JSON');
  const action: ModerationAction =
    body.action === 'dropped_as_phishing' ||
    body.action === 'dropped_as_spam' ||
    body.action === 'dropped_as_marketing'
      ? body.action
      : 'dropped_as_phishing';
  const held = await loadHeldOrFail(c.env, id);
  if (!held) return buildError(c, 'not_found', 'held message not actionable');
  const decision = await loadDecision(c.env, held.decision_id);
  if (!decision) return buildError(c, 'not_found', 'decision missing for held message');

  const apiKey = c.get('apiKey');
  const adminId = apiKey?.principal_id ?? 'unknown';

  // For outbound the message row stays at status='held' since we never
  // want to send it. For inbound there's no message row anyway. Either
  // way we just mark the held_messages row + write the feedback row.
  await applyMarkReleased(c.env, id, adminId, 'dropped');
  await recordFeedback(c.env, held, decision, adminId, action, body.notes, body.corrected_verdict);
  await audit(c.env, {
    actor: adminId,
    action: 'message.held_drop',
    target: held.id,
    meta: { decision_id: decision.id, direction: held.direction, action },
  });
  return c.json({ ok: true, held_id: held.id, dropped: true });
});

moderation.post('/v1/admin/policy/held/:id/reclassify', requireScope('admin:write'), async (c) => {
  const id = c.req.param('id');
  const body = parseBody(bodyText(c));
  if (body === null || !body.corrected_verdict) {
    return buildError(c, 'bad_request', 'corrected_verdict required');
  }
  const held = await loadHeldOrFail(c.env, id);
  if (!held) return buildError(c, 'not_found', 'held message not actionable');
  const decision = await loadDecision(c.env, held.decision_id);
  if (!decision) return buildError(c, 'not_found', 'decision missing for held message');

  const apiKey = c.get('apiKey');
  const adminId = apiKey?.principal_id ?? 'unknown';
  await recordFeedback(
    c.env,
    held,
    decision,
    adminId,
    'reclassified',
    body.notes,
    body.corrected_verdict,
  );
  await audit(c.env, {
    actor: adminId,
    action: 'moderation.feedback_recorded',
    target: held.id,
    meta: { decision_id: decision.id, corrected_verdict: body.corrected_verdict },
  });
  return c.json({ ok: true, held_id: held.id, recorded: true });
});
