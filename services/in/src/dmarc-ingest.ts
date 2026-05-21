// W6 — DMARC RUA inbound ingestion.
//
// Inbound mail to the platform DMARC RUA mailbox lands here. Walks the
// MIME body looking for the gzipped XML payload (Content-Type usually
// application/gzip with a .xml.gz filename), gunzips + parses via
// @polaris-mail/dmarc-parser, writes both the per-report row and the
// per-(domain, day) alignment rollup that W8's auto-promotion cron reads.

import { parseDmarcReportXml, gunzipUtf8, type DmarcReport } from '@polaris-mail/dmarc-parser';
import { ulid } from '@polaris-mail/ids';

export const PLATFORM_DMARC_REPORTS_MAILBOX_ID = '01HXPLATFORMDMARCREPORTS00';

interface D1RunResult {
  meta?: { changes?: number; rows_written?: number };
  success?: boolean;
}
interface D1Stmt {
  bind(...params: unknown[]): D1Stmt;
  run(): Promise<D1RunResult>;
}
interface D1 {
  prepare(sql: string): D1Stmt;
  batch(statements: D1Stmt[]): Promise<unknown[]>;
}

export interface DmarcIngestResult {
  reportRowId: string | null;
  domain: string | null;
  totalCount: number;
  rollupDay: string | null;
}

interface MimePart {
  contentType: string;
  contentTransferEncoding: string;
  body: Uint8Array;
}

function decodeBase64(s: string): Uint8Array {
  const clean = s.replace(/[\s]/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function escapeRegExpChars(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function* iterateMimeParts(raw: string, boundary: string): IterableIterator<MimePart> {
  const delim = '--' + boundary;
  const after = raw.indexOf(delim);
  if (after < 0) return;
  const rest = raw.slice(after);
  const re = new RegExp('\\r?\\n?' + escapeRegExpChars(delim) + '(?:--)?\\r?\\n?');
  for (const t of rest.split(re)) {
    const trimmed = t.replace(/^\r?\n/, '');
    if (!trimmed || trimmed === '--') continue;
    const headerEndCRLF = trimmed.indexOf('\r\n\r\n');
    const headerEndLF = trimmed.indexOf('\n\n');
    const idx = headerEndCRLF >= 0 ? headerEndCRLF : headerEndLF;
    const sep = headerEndCRLF >= 0 ? 4 : 2;
    if (idx < 0) continue;
    const headerBlob = trimmed.slice(0, idx);
    const bodyText = trimmed.slice(idx + sep);
    const headers: Record<string, string> = {};
    for (const line of headerBlob.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
      const ci = line.indexOf(':');
      if (ci <= 0) continue;
      headers[line.slice(0, ci).trim().toLowerCase()] = line.slice(ci + 1).trim();
    }
    const ct = headers['content-type'] ?? '';
    const cte = (headers['content-transfer-encoding'] ?? '7bit').toLowerCase();
    const body = cte === 'base64' ? decodeBase64(bodyText) : new TextEncoder().encode(bodyText);
    yield { contentType: ct, contentTransferEncoding: cte, body };
  }
}

function findDmarcPart(raw: string): { kind: 'gzip' | 'xml'; part: MimePart } | null {
  const ctMatch = /content-type:\s*([^\r\n]+)/i.exec(raw);
  if (!ctMatch) return null;
  const topCt = ctMatch[1] ?? '';
  const boundaryMatch = /boundary\s*=\s*("?)([^";\r\n]+)\1/i.exec(topCt);
  if (!boundaryMatch || !boundaryMatch[2]) {
    if (/application\/(gzip|x-gzip|zip)|text\/xml/i.test(topCt)) {
      const headerEndCRLF = raw.indexOf('\r\n\r\n');
      const headerEndLF = raw.indexOf('\n\n');
      const idx = headerEndCRLF >= 0 ? headerEndCRLF : headerEndLF;
      const sep = headerEndCRLF >= 0 ? 4 : 2;
      if (idx < 0) return null;
      const cteMatch = /content-transfer-encoding:\s*([^\r\n]+)/i.exec(raw.slice(0, idx));
      const cte = (cteMatch?.[1] ?? '7bit').toLowerCase();
      const bodyText = raw.slice(idx + sep);
      const body = cte === 'base64' ? decodeBase64(bodyText) : new TextEncoder().encode(bodyText);
      return {
        kind: /text\/xml/i.test(topCt) ? 'xml' : 'gzip',
        part: { contentType: topCt, contentTransferEncoding: cte, body },
      };
    }
    return null;
  }
  for (const p of iterateMimeParts(raw, boundaryMatch[2])) {
    if (/application\/(gzip|x-gzip)/i.test(p.contentType)) return { kind: 'gzip', part: p };
    if (/text\/xml|application\/xml/i.test(p.contentType)) return { kind: 'xml', part: p };
  }
  return null;
}

async function writeReport(
  db: D1,
  report: DmarcReport,
  sourceMessageId: string | null,
): Promise<{ id: string; domain: string | null; deduped: boolean }> {
  const id = ulid();
  const nowIso = new Date().toISOString();
  // INSERT OR IGNORE absorbs replays of the same (domain, report_id) — the
  // partial unique index added in 0020_polish.sql is the dedup key. If
  // report_id is NULL the index doesn't apply and the insert always lands;
  // callers tolerate occasional duplicates from providers that omit report-id.
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO dmarc_aggregate_reports
         (id, domain, org_name, org_email, report_id,
          date_range_begin, date_range_end,
          policy_p, policy_sp, policy_pct, policy_adkim, policy_aspf,
          total_count, total_dmarc_pass, total_dkim_pass, total_spf_pass,
          records_json, source, source_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'arf_inbox', ?, ?)`,
    )
    .bind(
      id,
      report.policyDomain,
      report.orgName,
      report.orgEmail,
      report.reportId,
      report.dateRangeBegin,
      report.dateRangeEnd,
      report.policyP,
      report.policySp,
      report.policyPct,
      report.policyAdkim,
      report.policyAspf,
      report.totalCount,
      report.totalDmarcPass,
      report.totalDkimPass,
      report.totalSpfPass,
      JSON.stringify(report.records),
      sourceMessageId,
      nowIso,
    )
    .run();
  const changes = result.meta?.changes ?? result.meta?.rows_written ?? 1;
  return { id, domain: report.policyDomain, deduped: changes === 0 };
}

async function updateRollup(
  db: D1,
  domain: string | null,
  report: DmarcReport,
): Promise<string | null> {
  if (!domain) return null;
  const day = (report.dateRangeEnd ?? new Date().toISOString()).slice(0, 10);
  const nowIso = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO dmarc_alignment_rollup
         (domain, day, reports, total_count, dmarc_pass, dkim_pass, spf_pass, last_seen_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(domain, day) DO UPDATE SET
         reports = reports + 1,
         total_count = total_count + ?,
         dmarc_pass = dmarc_pass + ?,
         dkim_pass = dkim_pass + ?,
         spf_pass = spf_pass + ?,
         last_seen_at = ?`,
    )
    .bind(
      domain,
      day,
      report.totalCount,
      report.totalDmarcPass,
      report.totalDkimPass,
      report.totalSpfPass,
      nowIso,
      report.totalCount,
      report.totalDmarcPass,
      report.totalDkimPass,
      report.totalSpfPass,
      nowIso,
    )
    .run();
  return day;
}

export async function handleDmarcReport(
  db: D1,
  rawMime: Uint8Array,
  sourceMessageId: string | null,
): Promise<DmarcIngestResult> {
  const raw = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(rawMime);
  const part = findDmarcPart(raw);
  if (!part) {
    return { reportRowId: null, domain: null, totalCount: 0, rollupDay: null };
  }
  let xml: string;
  if (part.kind === 'gzip') {
    xml = await gunzipUtf8(part.part.body);
  } else {
    xml = new TextDecoder('utf-8').decode(part.part.body);
  }
  const report = parseDmarcReportXml(xml);
  const { id, domain, deduped } = await writeReport(db, report, sourceMessageId);
  // Skip rollup updates on dedup hits — replaying a report must not double-count.
  const rollupDay = deduped ? null : await updateRollup(db, domain, report);
  return {
    reportRowId: deduped ? null : id,
    domain,
    totalCount: deduped ? 0 : report.totalCount,
    rollupDay,
  };
}
