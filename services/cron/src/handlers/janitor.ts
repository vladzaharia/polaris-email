// Nightly: enforce per-tenant retention by deleting old messages + their R2
// bodies, and purge expired idempotency_keys.
import type { Env } from '../env.js';

interface TenantRow {
  id: string;
  retention_days: number;
}

interface MessageRow {
  id: string;
  r2_key: string;
}

export async function janitor(env: Env): Promise<void> {
  const tenants = await env.DB.prepare(
    `SELECT id, retention_days FROM tenants WHERE disabled_at IS NULL`,
  ).all<TenantRow>();

  let deletedMessages = 0;
  for (const t of tenants.results) {
    if (!t.retention_days || t.retention_days <= 0) continue;
    const cutoff = new Date(Date.now() - t.retention_days * 86400_000).toISOString();
    const rows = await env.DB.prepare(
      `SELECT id, r2_key FROM messages WHERE tenant_id = ? AND created_at < ? LIMIT 500`,
    )
      .bind(t.id, cutoff)
      .all<MessageRow>();
    for (const r of rows.results) {
      try {
        await env.R2.delete(r.r2_key);
      } catch {
        // R2 already gone — proceed.
      }
      await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(r.id).run();
      deletedMessages++;
    }
  }

  // Sweep expired idempotency keys.
  const nowIso = new Date().toISOString();
  const idemDeleted = await env.DB.prepare(
    `DELETE FROM idempotency_keys WHERE expires_at IS NOT NULL AND expires_at < ?`,
  )
    .bind(nowIso)
    .run();

  // eslint-disable-next-line no-console
  console.log(
    `janitor: deleted ${deletedMessages} messages, ${idemDeleted.meta.changes ?? 0} idempotency rows`,
  );
}
