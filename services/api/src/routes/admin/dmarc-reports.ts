// W6 — Admin REST over dmarc_aggregate_reports + per-domain alignment rollup.
//
// Read-only. List + detail + per-domain summary feed the panel's DMARC
// alignment subsection on the domain detail page AND a fleet-wide
// /reports/dmarc view.
import { Hono } from 'hono';
import { requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const dmarcReports = new Hono<{ Bindings: Env }>();

interface ReportRow {
  id: string;
  domain: string | null;
  org_name: string | null;
  org_email: string | null;
  report_id: string | null;
  date_range_begin: string | null;
  date_range_end: string | null;
  policy_p: string | null;
  policy_sp: string | null;
  policy_pct: number | null;
  policy_adkim: string | null;
  policy_aspf: string | null;
  total_count: number;
  total_dmarc_pass: number;
  total_dkim_pass: number;
  total_spf_pass: number;
  records_json: string;
  source: string;
  source_message_id: string | null;
  created_at: string;
}

const COLS =
  'id, domain, org_name, org_email, report_id, date_range_begin, date_range_end, ' +
  'policy_p, policy_sp, policy_pct, policy_adkim, policy_aspf, ' +
  'total_count, total_dmarc_pass, total_dkim_pass, total_spf_pass, ' +
  'records_json, source, source_message_id, created_at';

dmarcReports.get('/v1/admin/dmarc-reports', requireScope('admin:read'), async (c) => {
  const domain = c.req.query('domain');
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '100'), 1), 500);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (domain) {
    where.push('domain = ?');
    binds.push(domain);
  }
  const sql =
    `SELECT ${COLS} FROM dmarc_aggregate_reports` +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY created_at DESC LIMIT ?';
  binds.push(limit);
  const rows = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all<ReportRow>();
  return c.json({ data: rows.results ?? [] });
});

dmarcReports.get('/v1/admin/dmarc-reports/:id', requireScope('admin:read'), async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(`SELECT ${COLS} FROM dmarc_aggregate_reports WHERE id = ?`)
    .bind(id)
    .first<ReportRow>();
  if (!row) return buildError(c, 'not_found', 'dmarc report not found');
  return c.json(row);
});

// Per-domain alignment summary the W8 promotion cron + panel both consume.
dmarcReports.get('/v1/admin/dmarc-reports/summary', requireScope('admin:read'), async (c) => {
  const domain = c.req.query('domain');
  if (!domain) return buildError(c, 'bad_request', 'domain query param required');
  const today = new Date().toISOString().slice(0, 10);
  const day7 = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString().slice(0, 10);
  const day14 = new Date(Date.now() - 14 * 24 * 3_600_000).toISOString().slice(0, 10);
  const day30 = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString().slice(0, 10);

  async function aggregate(sinceDay: string): Promise<{
    reports: number;
    total: number;
    dmarc_pass: number;
    dkim_pass: number;
    spf_pass: number;
    dmarc_pass_pct: number;
    dkim_pass_pct: number;
    spf_pass_pct: number;
    last_seen_at: string | null;
  }> {
    const row = await c.env.DB.prepare(
      `SELECT COALESCE(SUM(reports), 0) AS reports,
              COALESCE(SUM(total_count), 0) AS total,
              COALESCE(SUM(dmarc_pass), 0) AS dmarc_pass,
              COALESCE(SUM(dkim_pass), 0) AS dkim_pass,
              COALESCE(SUM(spf_pass), 0) AS spf_pass,
              MAX(last_seen_at) AS last_seen_at
       FROM dmarc_alignment_rollup WHERE domain = ? AND day >= ?`,
    )
      .bind(domain, sinceDay)
      .first<{
        reports: number;
        total: number;
        dmarc_pass: number;
        dkim_pass: number;
        spf_pass: number;
        last_seen_at: string | null;
      }>();
    const total = row?.total ?? 0;
    const pct = (n: number): number => (total === 0 ? 0 : Math.round((n / total) * 10000) / 100);
    return {
      reports: row?.reports ?? 0,
      total,
      dmarc_pass: row?.dmarc_pass ?? 0,
      dkim_pass: row?.dkim_pass ?? 0,
      spf_pass: row?.spf_pass ?? 0,
      dmarc_pass_pct: pct(row?.dmarc_pass ?? 0),
      dkim_pass_pct: pct(row?.dkim_pass ?? 0),
      spf_pass_pct: pct(row?.spf_pass ?? 0),
      last_seen_at: row?.last_seen_at ?? null,
    };
  }

  return c.json({
    domain,
    today,
    last_7d: await aggregate(day7),
    last_14d: await aggregate(day14),
    last_30d: await aggregate(day30),
  });
});
