// W2b — Admin REST over the triage_events ledger.
//
// List/detail + an operator-override endpoint that records a human
// disagreement with the LLM's verdict so we can iterate on the prompt
// using the panel feedback set.
import { Hono } from 'hono';
import { actorOf, audit } from '../../audit.js';
import { bodyText, requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const triageEvents = new Hono<{ Bindings: Env }>();

interface TriageEventRow {
  id: string;
  message_id: string | null;
  inbound_alias: string | null;
  model: string;
  prompt_hash: string;
  response_json: string;
  category: string;
  severity: string;
  confidence: number;
  actionable: number;
  target_recipient: string | null;
  target_sender_principal: string | null;
  target_message_id: string | null;
  summary: string | null;
  applied_suppression_id: string | null;
  operator_verdict: string | null;
  created_at: string;
}

const COLS =
  'id, message_id, inbound_alias, model, prompt_hash, response_json, category, severity, ' +
  'confidence, actionable, target_recipient, target_sender_principal, target_message_id, ' +
  'summary, applied_suppression_id, operator_verdict, created_at';

triageEvents.get('/v1/admin/triage-events', requireScope('admin:read'), async (c) => {
  const category = c.req.query('category');
  const severity = c.req.query('severity');
  const actionable = c.req.query('actionable');
  const minConfidence = c.req.query('min_confidence');
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '100'), 1), 500);

  const where: string[] = [];
  const binds: unknown[] = [];
  if (category) {
    where.push('category = ?');
    binds.push(category);
  }
  if (severity) {
    where.push('severity = ?');
    binds.push(severity);
  }
  if (actionable === '1' || actionable === '0') {
    where.push('actionable = ?');
    binds.push(Number(actionable));
  }
  if (minConfidence != null && minConfidence !== '') {
    where.push('confidence >= ?');
    binds.push(Number(minConfidence));
  }
  const sortBy = c.req.query('sort') === 'low_confidence' ? 'confidence ASC' : 'created_at DESC';
  const sql =
    `SELECT ${COLS} FROM triage_events` +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ` ORDER BY ${sortBy} LIMIT ?`;
  binds.push(limit);
  const rows = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all<TriageEventRow>();
  return c.json({ data: rows.results ?? [] });
});

triageEvents.get('/v1/admin/triage-events/:id', requireScope('admin:read'), async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(`SELECT ${COLS} FROM triage_events WHERE id = ?`)
    .bind(id)
    .first<TriageEventRow>();
  if (!row) return buildError(c, 'not_found', 'triage event not found');
  return c.json(row);
});

// Per-day summary for the panel diagnostics widget + W2b feedback loop.
triageEvents.get('/v1/admin/triage-events/summary', requireScope('admin:read'), async (c) => {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const rows = await c.env.DB.prepare(
    `SELECT category, severity,
            COUNT(*) AS total,
            SUM(actionable) AS actionables,
            AVG(confidence) AS avg_confidence,
            COUNT(applied_suppression_id) AS suppressions_fired
     FROM triage_events
     WHERE created_at >= ?
     GROUP BY category, severity
     ORDER BY total DESC`,
  )
    .bind(since)
    .all<{
      category: string;
      severity: string;
      total: number;
      actionables: number;
      avg_confidence: number;
      suppressions_fired: number;
    }>();
  return c.json({ since, data: rows.results ?? [] });
});

// Operator override — records a human verdict + optional rationale, and
// can opt-in to disabling the applied suppression if the LLM was wrong.
triageEvents.post(
  '/v1/admin/triage-events/:id/override',
  requireScope('admin:rotate'),
  async (c) => {
    const id = c.req.param('id');
    let body: { verdict: string; rationale?: string; disable_suppression?: boolean };
    try {
      body = JSON.parse(bodyText(c) || '{}') as typeof body;
    } catch {
      return buildError(c, 'bad_request', 'invalid json');
    }
    if (!body.verdict || typeof body.verdict !== 'string') {
      return buildError(c, 'bad_request', 'verdict (string) required');
    }
    const existing = await c.env.DB.prepare(
      `SELECT id, applied_suppression_id FROM triage_events WHERE id = ?`,
    )
      .bind(id)
      .first<{ id: string; applied_suppression_id: string | null }>();
    if (!existing) return buildError(c, 'not_found', 'triage event not found');

    const nowIso = new Date().toISOString();
    await c.env.DB.prepare(`UPDATE triage_events SET operator_verdict = ? WHERE id = ?`)
      .bind(
        JSON.stringify({ verdict: body.verdict, rationale: body.rationale ?? null, at: nowIso }),
        id,
      )
      .run();

    if (body.disable_suppression && existing.applied_suppression_id) {
      await c.env.DB.prepare(
        `UPDATE suppressions SET disabled_at = ?, disabled_reason = ?
        WHERE id = ? AND disabled_at IS NULL`,
      )
        .bind(
          nowIso,
          `operator override via triage ${id}: ${body.verdict}`,
          existing.applied_suppression_id,
        )
        .run();
    }

    await audit(c.env, {
      actor: actorOf(c),
      action: 'triage.operator_override',
      target: id,
      meta: {
        verdict: body.verdict,
        rationale: body.rationale ?? null,
        disabled_suppression: body.disable_suppression ? existing.applied_suppression_id : null,
      },
    });

    return c.json({ id, operator_verdict: body.verdict });
  },
);
