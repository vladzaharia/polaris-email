// Admin stats overview aggregator.
//
// Single endpoint backing the panel dashboard: counts per status grouped by
// direction within a window, plus per-resource cardinalities (mailboxes,
// domains, senders, credentials, webhook-subs) and DLQ depth.
import { Hono } from 'hono';
import { requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const stats = new Hono<{ Bindings: Env }>();

function windowToHours(w: string | null): number {
  if (w === '7d') return 24 * 7;
  if (w === '30d') return 24 * 30;
  // Default 24h.
  return 24;
}

interface Counts {
  sent: number;
  delivered: number;
  failed: number;
  bounced: number;
  inbound_received: number;
}

stats.get('/v1/admin/stats/overview', requireScope('admin:read'), async (c) => {
  const window = c.req.query('window') ?? '24h';
  if (!['24h', '7d', '30d'].includes(window)) {
    return buildError(c, 'bad_request', 'window must be one of 24h, 7d, 30d');
  }
  const hours = windowToHours(window);
  const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  // Cardinalities (cheap COUNT(*) queries; ignore failures so degraded envs
  // still return a partial payload).
  const safeCount = async (sql: string): Promise<number> => {
    try {
      const r = await c.env.DB.prepare(sql).first<{ n: number }>();
      return Number(r?.n ?? 0);
    } catch {
      return 0;
    }
  };

  // Exclude sentinel mailboxes (`_polaris_*`) — operator-system internals.
  const mailboxCount = await safeCount(
    `SELECT COUNT(*) AS n FROM mailboxes WHERE disabled_at IS NULL AND name NOT LIKE '\\_polaris\\_%' ESCAPE '\\'`,
  );
  const domainVerified = await safeCount(
    `SELECT COUNT(*) AS n FROM mail_domains WHERE status = 'verified' AND disabled_at IS NULL`,
  );
  const domainPending = await safeCount(
    `SELECT COUNT(*) AS n FROM mail_domains WHERE status = 'pending' AND disabled_at IS NULL`,
  );
  const domainFailed = await safeCount(
    `SELECT COUNT(*) AS n FROM mail_domains WHERE status = 'failed' AND disabled_at IS NULL`,
  );
  const senderCount = await safeCount(
    `SELECT COUNT(*) AS n FROM mailbox_senders WHERE disabled_at IS NULL`,
  );
  const apiKeyCount = await safeCount(
    `SELECT COUNT(*) AS n FROM api_keys WHERE status <> 'revoked'`,
  );
  const smtpCount = await safeCount(
    `SELECT COUNT(*) AS n FROM submission_credentials WHERE disabled_at IS NULL`,
  );
  const webhookSubCount = await safeCount(
    `SELECT COUNT(*) AS n FROM webhook_subs WHERE disabled_at IS NULL`,
  );
  const dlqDepth = await safeCount(
    `SELECT COUNT(*) AS n FROM webhook_dlq
       WHERE replayed_at IS NULL AND dropped_at IS NULL`,
  );

  // Direction × status window aggregate.
  const counts: Counts = {
    sent: 0,
    delivered: 0,
    failed: 0,
    bounced: 0,
    inbound_received: 0,
  };
  try {
    const rows = await c.env.DB.prepare(
      `SELECT direction, status, COUNT(*) AS n FROM messages
        WHERE created_at >= ?
        GROUP BY direction, status`,
    )
      .bind(sinceIso)
      .all<{ direction: 'in' | 'out'; status: string; n: number }>();
    for (const r of rows.results ?? []) {
      const n = Number(r.n);
      if (r.direction === 'out') {
        if (r.status === 'sent' || r.status === 'queued' || r.status === 'sending') {
          counts.sent += n;
        }
        if (r.status === 'delivered') counts.delivered += n;
        if (r.status === 'failed') counts.failed += n;
        if (r.status === 'bounced') counts.bounced += n;
      } else if (r.direction === 'in') {
        counts.inbound_received += n;
      }
    }
  } catch {
    // degraded — leave counts at 0
  }

  return c.json({
    window,
    cardinality: {
      mailboxes: mailboxCount,
      domains_verified: domainVerified,
      domains_pending: domainPending,
      domains_failed: domainFailed,
      senders: senderCount,
      credentials_api_key: apiKeyCount,
      credentials_smtp: smtpCount,
      webhook_subs: webhookSubCount,
    },
    messages: counts,
    dlq_depth: dlqDepth,
  });
});

// Per-credential stats (sent/delivered/failed within the window). Used by the
// credential detail page; the actor → message linkage rides through the
// `messages.principal_id` column (api_keys.principal_id /
// submission_credentials.principal_id).
stats.get('/v1/admin/credentials/:id/stats', requireScope('admin:read'), async (c) => {
  const window = c.req.query('window') ?? '24h';
  if (!['24h', '7d', '30d'].includes(window)) {
    return buildError(c, 'bad_request', 'window must be one of 24h, 7d, 30d');
  }
  const id = c.req.param('id');
  // Resolve principal_id from either api_keys or submission_credentials.
  let principalId: string | null = null;
  try {
    const ak = await c.env.DB.prepare(`SELECT principal_id FROM api_keys WHERE id = ?`)
      .bind(id)
      .first<{ principal_id: string }>();
    if (ak) principalId = ak.principal_id;
    if (!principalId) {
      const sc = await c.env.DB.prepare(
        `SELECT principal_id FROM submission_credentials WHERE id = ?`,
      )
        .bind(id)
        .first<{ principal_id: string }>();
      if (sc) principalId = sc.principal_id;
    }
  } catch {
    // fall through
  }
  if (!principalId) return buildError(c, 'not_found', 'credential not found');

  const hours = windowToHours(window);
  const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const counts = { sent: 0, delivered: 0, failed: 0, bounced: 0 };
  try {
    const rows = await c.env.DB.prepare(
      `SELECT status, COUNT(*) AS n FROM messages
         WHERE principal_id = ? AND created_at >= ?
         GROUP BY status`,
    )
      .bind(principalId, sinceIso)
      .all<{ status: string; n: number }>();
    for (const r of rows.results ?? []) {
      const n = Number(r.n);
      if (r.status === 'sent' || r.status === 'queued' || r.status === 'sending') counts.sent += n;
      if (r.status === 'delivered') counts.delivered += n;
      if (r.status === 'failed') counts.failed += n;
      if (r.status === 'bounced') counts.bounced += n;
    }
  } catch {
    // degraded
  }
  return c.json({ credential_id: id, window, counts });
});
