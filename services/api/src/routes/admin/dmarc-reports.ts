// Admin REST for DMARC reports.
//
// Source of truth is Cloudflare DMARC Management. The per-(domain, day)
// rollup mirror in D1 backs the summary endpoint so panel pageviews stay
// snappy and don't hit CF on every render; the list endpoint queries CF
// GraphQL live.

import { Hono } from 'hono';
import { CloudflareApiClient, fetchDmarcAggregatesByDay } from '@polaris-mail/cf-api';
import { requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const dmarcReports = new Hono<{ Bindings: Env }>();

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

dmarcReports.get('/v1/admin/dmarc-reports', requireScope('admin:read'), async (c) => {
  const domain = c.req.query('domain');
  if (!domain) return buildError(c, 'bad_request', 'domain query param required');
  const days = Math.min(Math.max(Number(c.req.query('days') ?? '7'), 1), 90);

  const row = await c.env.DB.prepare(
    `SELECT COALESCE(z.cf_zone_id, d.cf_zone_id) AS cf_zone_id
     FROM mail_domains d LEFT JOIN zones z ON z.id = d.zone_id
     WHERE d.name = ?`,
  )
    .bind(domain)
    .first<{ cf_zone_id: string | null }>();
  if (!row?.cf_zone_id) {
    return buildError(c, 'not_found', 'domain has no associated CF zone');
  }
  if (!c.env.CF_API_TOKEN || !c.env.CF_ACCOUNT_ID) {
    return buildError(c, 'degraded', 'CF credentials missing');
  }

  const until = new Date();
  until.setUTCHours(23, 59, 59, 999);
  const since = new Date(until.getTime() - days * 24 * 3_600_000);
  since.setUTCHours(0, 0, 0, 0);

  const client = new CloudflareApiClient({
    apiToken: c.env.CF_API_TOKEN,
    accountId: c.env.CF_ACCOUNT_ID,
  });

  try {
    const rows = await fetchDmarcAggregatesByDay(client, {
      zoneTag: row.cf_zone_id,
      since: since.toISOString(),
      until: until.toISOString(),
    });
    return c.json({ data: rows.filter((r) => r.domain === domain) });
  } catch (err) {
    return buildError(
      c,
      'cf_upstream',
      `cf graphql: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});
