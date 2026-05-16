// W5 — TLS-RPT (RFC 8460) aggregate-report parser.
//
// A TLS-RPT report arrives by email as a message/tlsrpt body part. The
// payload is a gzip-compressed JSON document with the shape documented in
// RFC 8460 §4.4:
//
//   {
//     "organization-name": "...",
//     "date-range": { "start-datetime": "...", "end-datetime": "..." },
//     "contact-info": "...",
//     "report-id": "...",
//     "policies": [
//       {
//         "policy": { "policy-type": "sts" | "tlsa" | "no-policy-found", ... },
//         "summary": { "total-successful-session-count": N,
//                      "total-failure-session-count": N },
//         "failure-details": [ { result-type, ... }, ... ]
//       },
//       ...
//     ]
//   }
//
// We parse leniently — every field is optional in the wild, especially
// `failure-details`. Anything missing surfaces as `null`/`0`/`[]` so the
// downstream rollup doesn't have to special-case it.

export interface TlsRptPolicy {
  policyType: string | null;
  policyDomain: string | null;
  policyString: string | null;
  mxHost: string | null;
  successCount: number;
  failureCount: number;
  failures: TlsRptFailure[];
}

export interface TlsRptFailure {
  resultType: string | null;
  sendingMtaIp: string | null;
  receivingMxHostname: string | null;
  receivingMxHelo: string | null;
  receivingIp: string | null;
  failedSessionCount: number;
  additionalInformation: string | null;
  failureReasonCode: string | null;
}

export interface TlsRptReport {
  organizationName: string | null;
  contactInfo: string | null;
  reportId: string | null;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  policies: TlsRptPolicy[];
  totalSuccessCount: number;
  totalFailureCount: number;
}

interface RawPolicyBlock {
  policy?: {
    'policy-type'?: string;
    'policy-domain'?: string;
    'policy-string'?: string | string[];
    'mx-host'?: string | string[];
  };
  summary?: {
    'total-successful-session-count'?: number;
    'total-failure-session-count'?: number;
  };
  'failure-details'?: Array<{
    'result-type'?: string;
    'sending-mta-ip'?: string;
    'receiving-mx-hostname'?: string;
    'receiving-mx-helo'?: string;
    'receiving-ip'?: string;
    'failed-session-count'?: number;
    'additional-information'?: string;
    'failure-reason-code'?: string;
  }>;
}

interface RawReport {
  'organization-name'?: string;
  'contact-info'?: string;
  'report-id'?: string;
  'date-range'?: {
    'start-datetime'?: string;
    'end-datetime'?: string;
  };
  policies?: RawPolicyBlock[];
}

/**
 * Gunzip + JSON.parse a TLS-RPT report payload.
 *
 * Uses the web-standard `DecompressionStream('gzip')` (available in Workers
 * runtime + Node 17+); no dependency on a userland gzip lib.
 */
export async function gunzipJsonReport(gzipped: Uint8Array): Promise<unknown> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(gzipped);
      controller.close();
    },
  });
  // The DOM lib types DecompressionStream as ReadableWritablePair<BufferSource>
  // while @cloudflare/workers-types narrows it to Uint8Array; pipe via a cast
  // so this package can build under either lib set.
  const stream = source.pipeThrough(
    new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
  );
  const decompressed = await new Response(stream).arrayBuffer();
  const text = new TextDecoder('utf-8').decode(decompressed);
  return JSON.parse(text);
}

/**
 * Parse a TLS-RPT report from its already-decompressed JSON form. Use
 * `parseGzippedTlsRptReport()` to combine gunzip + parse in one call.
 */
export function parseTlsRptReportJson(raw: unknown): TlsRptReport {
  const r = (raw ?? {}) as RawReport;
  const policies: TlsRptPolicy[] = [];
  let totalSuccess = 0;
  let totalFailure = 0;
  for (const p of r.policies ?? []) {
    const succ = Number(p.summary?.['total-successful-session-count'] ?? 0) || 0;
    const fail = Number(p.summary?.['total-failure-session-count'] ?? 0) || 0;
    totalSuccess += succ;
    totalFailure += fail;
    const failures: TlsRptFailure[] = (p['failure-details'] ?? []).map((f) => ({
      resultType: f['result-type'] ?? null,
      sendingMtaIp: f['sending-mta-ip'] ?? null,
      receivingMxHostname: f['receiving-mx-hostname'] ?? null,
      receivingMxHelo: f['receiving-mx-helo'] ?? null,
      receivingIp: f['receiving-ip'] ?? null,
      failedSessionCount: Number(f['failed-session-count'] ?? 0) || 0,
      additionalInformation: f['additional-information'] ?? null,
      failureReasonCode: f['failure-reason-code'] ?? null,
    }));
    const policyString = Array.isArray(p.policy?.['policy-string'])
      ? (p.policy?.['policy-string'] ?? []).join('\n')
      : (p.policy?.['policy-string'] ?? null);
    const mxHost = Array.isArray(p.policy?.['mx-host'])
      ? (p.policy?.['mx-host'] ?? []).join(',')
      : (p.policy?.['mx-host'] ?? null);
    policies.push({
      policyType: p.policy?.['policy-type'] ?? null,
      policyDomain: p.policy?.['policy-domain'] ?? null,
      policyString: policyString ?? null,
      mxHost: mxHost ?? null,
      successCount: succ,
      failureCount: fail,
      failures,
    });
  }
  return {
    organizationName: r['organization-name'] ?? null,
    contactInfo: r['contact-info'] ?? null,
    reportId: r['report-id'] ?? null,
    dateRangeStart: r['date-range']?.['start-datetime'] ?? null,
    dateRangeEnd: r['date-range']?.['end-datetime'] ?? null,
    policies,
    totalSuccessCount: totalSuccess,
    totalFailureCount: totalFailure,
  };
}

export async function parseGzippedTlsRptReport(gzipped: Uint8Array): Promise<TlsRptReport> {
  const json = await gunzipJsonReport(gzipped);
  return parseTlsRptReportJson(json);
}
