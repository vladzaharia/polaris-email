// W5 — Admin REST over tls_rpt_reports + per-domain failure summary.
//
// Read-only. List + detail + summary endpoints feed the panel's TLS
// hardening "TLS report summary" subsection on the domain detail page
// (which extends the existing C.13 card) AND a fleet-wide /reports/tls-rpt
// view.
import { Hono } from 'hono';
import { requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const tlsRptReports = new Hono<{ Bindings: Env }>();

interface ReportRow {
  id: string;
  domain: string | null;
  organization_name: string | null;
  contact_info: string | null;
  report_id: string | null;
  date_range_start: string | null;
  date_range_end: string | null;
  total_success_count: number;
  total_failure_count: number;
  policies_json: string;
  source: string;
  source_message_id: string | null;
  created_at: string;
}

const COLS =
  'id, domain, organization_name, contact_info, report_id, date_range_start, date_range_end, ' +
  'total_success_count, total_failure_count, policies_json, source, source_message_id, created_at';

tlsRptReports.get('/v1/admin/tls-rpt-reports', requireScope('admin:read'), async (c) => {
  const domain = c.req.query('domain');
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '100'), 1), 500);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (domain) {
    where.push('domain = ?');
    binds.push(domain);
  }
  const sql =
    `SELECT ${COLS} FROM tls_rpt_reports` +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY created_at DESC LIMIT ?';
  binds.push(limit);
  const rows = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all<ReportRow>();
  return c.json({ data: rows.results ?? [] });
});

tlsRptReports.get('/v1/admin/tls-rpt-reports/:id', requireScope('admin:read'), async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(`SELECT ${COLS} FROM tls_rpt_reports WHERE id = ?`)
    .bind(id)
    .first<ReportRow>();
  if (!row) return buildError(c, 'not_found', 'tls-rpt report not found');
  return c.json(row);
});

// Per-domain summary used by the panel TLS hardening subsection. Returns
// 7-day and 30-day windows: report counts, total successful/failed
// sessions, and the top-N failure types.
tlsRptReports.get('/v1/admin/tls-rpt-reports/summary', requireScope('admin:read'), async (c) => {
  const domain = c.req.query('domain');
  if (!domain) return buildError(c, 'bad_request', 'domain query param required');
  const now = Date.now();
  const day7 = new Date(now - 7 * 24 * 3_600_000).toISOString();
  const day30 = new Date(now - 30 * 24 * 3_600_000).toISOString();

  async function aggregate(sinceIso: string): Promise<{
    reports: number;
    success: number;
    failure: number;
    latest_at: string | null;
  }> {
    const row = await c.env.DB.prepare(
      `SELECT COUNT(*) AS reports,
                COALESCE(SUM(total_success_count), 0) AS success,
                COALESCE(SUM(total_failure_count), 0) AS failure,
                MAX(created_at) AS latest_at
         FROM tls_rpt_reports WHERE domain = ? AND created_at >= ?`,
    )
      .bind(domain, sinceIso)
      .first<{ reports: number; success: number; failure: number; latest_at: string | null }>();
    return {
      reports: row?.reports ?? 0,
      success: row?.success ?? 0,
      failure: row?.failure ?? 0,
      latest_at: row?.latest_at ?? null,
    };
  }

  const topFailures = await c.env.DB.prepare(
    `SELECT result_type, SUM(failed_sessions) AS failed
       FROM tls_rpt_failure_summary
       WHERE domain = ? AND day >= ?
       GROUP BY result_type
       ORDER BY failed DESC LIMIT 10`,
  )
    .bind(domain, day7.slice(0, 10))
    .all<{ result_type: string; failed: number }>();

  return c.json({
    domain,
    last_7d: await aggregate(day7),
    last_30d: await aggregate(day30),
    top_failures_7d: topFailures.results ?? [],
  });
});
