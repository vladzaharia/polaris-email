// Daily DMARC aggregate mirror.
//
// Reads per-(domain, day) aggregates from Cloudflare DMARC Management via
// the GraphQL Analytics API and upserts them into dmarc_alignment_rollup.
// The promotion cron (dmarc-promote) reads the same table, so this is the
// only writer for the rollup since the ARF-inbox path was retired.

import { CloudflareApiClient, fetchDmarcAggregatesByDay } from '@polaris-mail/cf-api';
import type { Env } from '../env.js';

export interface DmarcMirrorResult {
  zones: number;
  rowsUpserted: number;
  failed: number;
  skipped: number;
}

interface DomainRow {
  id: string;
  name: string;
  cf_zone_id: string | null;
}

export interface DmarcMirrorOverrides {
  fetchImpl?: typeof fetch;
  apiToken?: string;
  accountId?: string;
}

function isoDayStart(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 24 * 3_600_000);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function isoDayEnd(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 24 * 3_600_000);
  d.setUTCHours(23, 59, 59, 999);
  return d.toISOString();
}

export async function dmarcMirrorRun(
  env: Env,
  overrides: DmarcMirrorOverrides = {},
): Promise<DmarcMirrorResult> {
  const result: DmarcMirrorResult = { zones: 0, rowsUpserted: 0, failed: 0, skipped: 0 };

  const apiToken = overrides.apiToken ?? env.CF_API_TOKEN;
  const accountId = overrides.accountId ?? env.CF_ACCOUNT_ID;
  if (!apiToken || !accountId) {
    return result;
  }

  const domains = await env.DB.prepare(
    `SELECT d.id, d.name,
            COALESCE(z.cf_zone_id, d.cf_zone_id) AS cf_zone_id
     FROM mail_domains d
     LEFT JOIN zones z ON z.id = d.zone_id
     WHERE d.status = 'verified'`,
  ).all<DomainRow>();

  const client = new CloudflareApiClient({
    apiToken,
    accountId,
    fetchImpl: overrides.fetchImpl,
  });

  const since = isoDayStart(2);
  const until = isoDayEnd(0);
  const nowIso = new Date().toISOString();

  for (const d of domains.results ?? []) {
    if (!d.cf_zone_id) {
      result.skipped++;
      continue;
    }
    result.zones++;
    try {
      const rows = await fetchDmarcAggregatesByDay(client, {
        zoneTag: d.cf_zone_id,
        since,
        until,
      });
      for (const r of rows) {
        await env.DB.prepare(
          `INSERT INTO dmarc_alignment_rollup
             (domain, day, reports, total_count, dmarc_pass, dkim_pass, spf_pass, last_seen_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?)
           ON CONFLICT(domain, day) DO UPDATE SET
             total_count = excluded.total_count,
             dmarc_pass = excluded.dmarc_pass,
             dkim_pass = excluded.dkim_pass,
             spf_pass = excluded.spf_pass,
             last_seen_at = excluded.last_seen_at`,
        )
          .bind(r.domain, r.day, r.totalCount, r.dmarcPass, r.dkimPass, r.spfPass, nowIso)
          .run();
        result.rowsUpserted++;
      }
    } catch (err) {
      result.failed++;
      // eslint-disable-next-line no-console
      console.warn('dmarc-mirror: zone failed', {
        domain: d.name,
        zone: d.cf_zone_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
