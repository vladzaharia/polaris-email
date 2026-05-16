// W11 — Admin REST over synthetic_runs ledger.
//
// Read-only. Powers the panel diagnostics page's synthetic monitoring widget.
import { Hono } from 'hono';
import { requireScope } from '../../auth.js';
import type { Env } from '../../env.js';

export const syntheticRuns = new Hono<{ Bindings: Env }>();

interface RunRow {
  id: string;
  check_kind: string;
  target: string;
  ok: number;
  latency_ms: number | null;
  detail: string;
  run_at: string;
}

syntheticRuns.get('/v1/admin/synthetic-runs', requireScope('admin:read'), async (c) => {
  const kind = c.req.query('check_kind');
  const target = c.req.query('target');
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '100'), 1), 500);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (kind) {
    where.push('check_kind = ?');
    binds.push(kind);
  }
  if (target) {
    where.push('target = ?');
    binds.push(target);
  }
  const sql =
    `SELECT id, check_kind, target, ok, latency_ms, detail, run_at FROM synthetic_runs` +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY run_at DESC LIMIT ?';
  binds.push(limit);
  const rows = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all<RunRow>();
  return c.json({ data: rows.results ?? [] });
});

// Summary for the panel diagnostics widget: per check_kind, latest run +
// success rate over the last 24h.
syntheticRuns.get('/v1/admin/synthetic-runs/summary', requireScope('admin:read'), async (c) => {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const rows = await c.env.DB.prepare(
    `SELECT check_kind,
            COUNT(*) AS total,
            SUM(ok) AS passes,
            AVG(latency_ms) AS avg_latency_ms,
            MAX(run_at) AS latest_at
     FROM synthetic_runs
     WHERE run_at >= ?
     GROUP BY check_kind`,
  )
    .bind(since)
    .all<{
      check_kind: string;
      total: number;
      passes: number;
      avg_latency_ms: number;
      latest_at: string;
    }>();
  return c.json({ data: rows.results ?? [] });
});
