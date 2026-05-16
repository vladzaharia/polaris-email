// W2 — Admin read-only surface over the `abuse_events` ledger.
//
// Populated by W2 (deterministic ARF/DSN), W2b (LLM triage), W3 (CF bounce
// webhook). Read by the panel's /reports/abuse page so operators can see
// the raw complaint history for any sender principal.
//
// Approval-gating: read-only routes only. No mutations live here — the
// table is immutable.
import { Hono } from 'hono';
import { requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const abuseEvents = new Hono<{ Bindings: Env }>();

interface AbuseEventRow {
  id: string;
  sender_address: string | null;
  sender_principal_mailbox_id: string | null;
  sender_principal_sender_id: string | null;
  sender_principal_domain_id: string | null;
  classification: string;
  source: string;
  source_ref: string | null;
  weight: number;
  reporter_address: string | null;
  reporter_org: string | null;
  original_message_id: string | null;
  raw_meta: string;
  caused_suppression_id: string | null;
  reported_at: string;
  created_at: string;
}

const COLS =
  'id, sender_address, sender_principal_mailbox_id, sender_principal_sender_id, ' +
  'sender_principal_domain_id, classification, source, source_ref, weight, ' +
  'reporter_address, reporter_org, original_message_id, raw_meta, ' +
  'caused_suppression_id, reported_at, created_at';

abuseEvents.get('/v1/admin/abuse-events', requireScope('admin:read'), async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '100'), 1), 500);
  const senderAddress = c.req.query('sender_address');
  const mailboxId = c.req.query('mailbox_id');
  const domainId = c.req.query('domain_id');
  const classification = c.req.query('classification');
  const source = c.req.query('source');
  const since = c.req.query('since');
  const cursor = c.req.query('cursor');

  const where: string[] = [];
  const binds: unknown[] = [];
  if (senderAddress) {
    where.push('sender_address = ?');
    binds.push(senderAddress.toLowerCase());
  }
  if (mailboxId) {
    where.push('sender_principal_mailbox_id = ?');
    binds.push(mailboxId);
  }
  if (domainId) {
    where.push('sender_principal_domain_id = ?');
    binds.push(domainId);
  }
  if (classification) {
    where.push('classification = ?');
    binds.push(classification);
  }
  if (source) {
    where.push('source = ?');
    binds.push(source);
  }
  if (since) {
    where.push('reported_at >= ?');
    binds.push(since);
  }
  if (cursor) {
    where.push('reported_at < ?');
    binds.push(cursor);
  }
  const sql =
    `SELECT ${COLS} FROM abuse_events` +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY reported_at DESC LIMIT ?';
  binds.push(limit);
  const rows = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all<AbuseEventRow>();
  const data = rows.results ?? [];
  const next_cursor = data.length === limit ? (data[data.length - 1]?.reported_at ?? null) : null;
  return c.json({ data, next_cursor });
});

abuseEvents.get('/v1/admin/abuse-events/:id', requireScope('admin:read'), async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(`SELECT ${COLS} FROM abuse_events WHERE id = ?`)
    .bind(id)
    .first<AbuseEventRow>();
  if (!row) return buildError(c, 'not_found', 'abuse event not found');
  return c.json(row);
});

// Per-principal summary — `count` + `weighted_score` over the last 24h, 7d,
// 30d, all-time. Used by the panel's sender-profile drill-down.
abuseEvents.get('/v1/admin/abuse-events/summary', requireScope('admin:read'), async (c) => {
  const senderAddress = c.req.query('sender_address');
  const mailboxId = c.req.query('mailbox_id');
  const domainId = c.req.query('domain_id');
  if (!senderAddress && !mailboxId && !domainId) {
    return buildError(c, 'bad_request', 'sender_address, mailbox_id, or domain_id required');
  }
  const filter: { col: string; val: string } = senderAddress
    ? { col: 'sender_address', val: senderAddress.toLowerCase() }
    : mailboxId
      ? { col: 'sender_principal_mailbox_id', val: mailboxId }
      : { col: 'sender_principal_domain_id', val: domainId! };

  const now = Date.now();
  const dayAgo = new Date(now - 24 * 3_600_000).toISOString();
  const weekAgo = new Date(now - 7 * 24 * 3_600_000).toISOString();
  const monthAgo = new Date(now - 30 * 24 * 3_600_000).toISOString();

  async function aggregate(since: string | null): Promise<{ count: number; score: number }> {
    const sql =
      `SELECT COUNT(*) AS count, COALESCE(SUM(weight), 0) AS score ` +
      `FROM abuse_events WHERE ${filter.col} = ?` +
      (since ? ' AND reported_at >= ?' : '');
    const binds = since ? [filter.val, since] : [filter.val];
    const row = await c.env.DB.prepare(sql)
      .bind(...binds)
      .first<{ count: number; score: number }>();
    return { count: row?.count ?? 0, score: row?.score ?? 0 };
  }

  return c.json({
    filter,
    windows: {
      last_24h: await aggregate(dayAgo),
      last_7d: await aggregate(weekAgo),
      last_30d: await aggregate(monthAgo),
      lifetime: await aggregate(null),
    },
  });
});
