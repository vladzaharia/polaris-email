// Admin status endpoint: counts and recent-activity summary for operators.
import { Hono } from 'hono';
import { requireScope } from '../../auth.js';
import type { Env } from '../../env.js';

export const status = new Hono<{ Bindings: Env }>();

async function count(env: Env, sql: string, params: unknown[] = []): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...params)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

status.get('/v1/admin/status', requireScope('admin:read'), async (c) => {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const mailboxes = await count(c.env, `SELECT COUNT(*) AS c FROM mailboxes WHERE disabled_at IS NULL`);
  const domains = await count(c.env, `SELECT COUNT(*) AS c FROM mail_domains WHERE disabled_at IS NULL`);
  const daemons = await count(c.env, `SELECT COUNT(*) AS c FROM daemons WHERE disabled_at IS NULL`);
  const apiKeys = await count(c.env, `SELECT COUNT(*) AS c FROM api_keys WHERE status <> 'revoked'`);
  const messagesLast24h = await count(
    c.env,
    `SELECT COUNT(*) AS c FROM messages WHERE created_at >= ?`,
    [dayAgo],
  );
  const dlqDepth = await count(
    c.env,
    `SELECT COUNT(*) AS c FROM webhook_dlq WHERE replayed_at IS NULL AND dropped_at IS NULL`,
  );
  return c.json({
    mailboxes,
    domains,
    daemons,
    api_keys: apiKeys,
    messages_last_24h: messagesLast24h,
    webhook_dlq_depth: dlqDepth,
  });
});
