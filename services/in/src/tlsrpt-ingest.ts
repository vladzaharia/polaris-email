// W5 — TLS-RPT inbound ingestion.
//
// Invoked from services/in when a message lands at the platform TLS-RPT
// mailbox. Walks the MIME body looking for an `application/tlsrpt+gzip`
// (or `application/tlsrpt+json`) part, then either gunzips + parses or
// JSON-parses directly. Persists one row in `tls_rpt_reports` and updates
// the per-(domain, day, result_type) rollup in `tls_rpt_failure_summary`.

import {
  parseGzippedTlsRptReport,
  parseTlsRptReportJson,
  type TlsRptReport,
} from '@polaris-mail/tlsrpt-parser';
import { ulid } from '@polaris-mail/ids';

export const PLATFORM_TLS_REPORTS_MAILBOX_ID = '01HXPLATFORMTLSREPORTS0000';

interface D1Stmt {
  bind(...params: unknown[]): D1Stmt;
  all<T = unknown>(): Promise<{ results: T[] }>;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<unknown>;
}
interface D1 {
  prepare(sql: string): D1Stmt;
  batch(statements: D1Stmt[]): Promise<unknown[]>;
}

export interface TlsRptIngestResult {
  reportId: string | null;
  reportRowId: string | null;
  failureSummaryRows: number;
  domain: string | null;
  totalFailureCount: number;
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
  const tokens = rest.split(re);
  for (const t of tokens) {
    const trimmed = t.replace(/^\r?\n/, '');
    if (!trimmed || trimmed === '--') continue;
    const headerEnd = (() => {
      const c = trimmed.indexOf('\r\n\r\n');
      if (c >= 0) return { idx: c, sep: 4 };
      const l = trimmed.indexOf('\n\n');
      if (l >= 0) return { idx: l, sep: 2 };
      return null;
    })();
    if (!headerEnd) continue;
    const headerBlob = trimmed.slice(0, headerEnd.idx);
    const bodyText = trimmed.slice(headerEnd.idx + headerEnd.sep);
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

function findReportPart(raw: string): MimePart | null {
  const ctMatch = /content-type:\s*([^\r\n]+)/i.exec(raw);
  if (!ctMatch) return null;
  const topCt = ctMatch[1] ?? '';
  if (/application\/tlsrpt\+(gzip|json)/i.test(topCt)) {
    const headerEndCRLF = raw.indexOf('\r\n\r\n');
    const headerEndLF = raw.indexOf('\n\n');
    const idx = headerEndCRLF >= 0 ? headerEndCRLF : headerEndLF;
    const sep = headerEndCRLF >= 0 ? 4 : 2;
    if (idx < 0) return null;
    const body = raw.slice(idx + sep);
    const cteMatch = /content-transfer-encoding:\s*([^\r\n]+)/i.exec(raw.slice(0, idx));
    const cte = (cteMatch?.[1] ?? '7bit').toLowerCase();
    return {
      contentType: topCt,
      contentTransferEncoding: cte,
      body: cte === 'base64' ? decodeBase64(body) : new TextEncoder().encode(body),
    };
  }
  const boundaryMatch = /boundary\s*=\s*("?)([^";\r\n]+)\1/i.exec(topCt);
  if (!boundaryMatch || !boundaryMatch[2]) return null;
  for (const p of iterateMimeParts(raw, boundaryMatch[2])) {
    if (/application\/tlsrpt\+(gzip|json)/i.test(p.contentType)) return p;
  }
  return null;
}

async function writeReport(
  db: D1,
  report: TlsRptReport,
  sourceMessageId: string | null,
): Promise<{ id: string; domain: string | null }> {
  const id = ulid();
  const nowIso = new Date().toISOString();
  const domain = report.policies[0]?.policyDomain ?? null;
  await db
    .prepare(
      `INSERT INTO tls_rpt_reports
         (id, domain, organization_name, contact_info, report_id,
          date_range_start, date_range_end,
          total_success_count, total_failure_count,
          policies_json, source, source_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'arf_inbox', ?, ?)`,
    )
    .bind(
      id,
      domain,
      report.organizationName,
      report.contactInfo,
      report.reportId,
      report.dateRangeStart,
      report.dateRangeEnd,
      report.totalSuccessCount,
      report.totalFailureCount,
      JSON.stringify(report.policies),
      sourceMessageId,
      nowIso,
    )
    .run();
  return { id, domain };
}

async function updateSummary(db: D1, domain: string | null, report: TlsRptReport): Promise<number> {
  if (!domain) return 0;
  const day = (report.dateRangeEnd ?? new Date().toISOString()).slice(0, 10);
  const counts = new Map<string, number>();
  for (const policy of report.policies) {
    for (const f of policy.failures) {
      const key = f.resultType ?? 'unknown';
      counts.set(key, (counts.get(key) ?? 0) + f.failedSessionCount);
    }
  }
  if (counts.size === 0) return 0;
  const nowIso = new Date().toISOString();
  const stmts: D1Stmt[] = [];
  for (const [resultType, failedSessions] of counts) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO tls_rpt_failure_summary (domain, day, result_type, failed_sessions, reports, last_seen_at)
           VALUES (?, ?, ?, ?, 1, ?)
           ON CONFLICT(domain, day, result_type) DO UPDATE SET
             failed_sessions = failed_sessions + ?,
             reports = reports + 1,
             last_seen_at = ?`,
        )
        .bind(domain, day, resultType, failedSessions, nowIso, failedSessions, nowIso),
    );
  }
  await db.batch(stmts);
  return counts.size;
}

export async function handleTlsRptReport(
  db: D1,
  rawMime: Uint8Array,
  sourceMessageId: string | null,
): Promise<TlsRptIngestResult> {
  const raw = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(rawMime);
  const part = findReportPart(raw);
  if (!part) {
    return {
      reportId: null,
      reportRowId: null,
      failureSummaryRows: 0,
      domain: null,
      totalFailureCount: 0,
    };
  }
  let report: TlsRptReport;
  if (/application\/tlsrpt\+gzip/i.test(part.contentType)) {
    report = await parseGzippedTlsRptReport(part.body);
  } else {
    report = parseTlsRptReportJson(JSON.parse(new TextDecoder('utf-8').decode(part.body)));
  }
  const { id, domain } = await writeReport(db, report, sourceMessageId);
  const failureSummaryRows = await updateSummary(db, domain, report);
  return {
    reportId: report.reportId,
    reportRowId: id,
    failureSummaryRows,
    domain,
    totalFailureCount: report.totalFailureCount,
  };
}
