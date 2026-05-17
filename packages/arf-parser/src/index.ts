// W2 — ARF (RFC 5965) and DSN (RFC 3464) MIME parsers.
//
// Goal: turn a raw inbound complaint email into a structured event the
// suppression pipeline and the abuse_events table can consume.
//
// We deliberately keep the parser tolerant: real-world ARF reports vary
// wildly in formatting (especially the original-message third part).
// Anything we cannot parse is surfaced as kind='unstructured' so the
// caller can fall back to W2b LLM triage instead of dropping the message.

export type ArfFeedbackType = 'abuse' | 'fraud' | 'virus' | 'auth-failure' | 'opt-out' | 'other';

export interface ArfReport {
  kind: 'arf';
  feedbackType: ArfFeedbackType;
  originalRcptTo: string | null;
  originalMailFrom: string | null;
  userAgent: string | null;
  reportingMta: string | null;
  arrivalDate: string | null;
  originalMessageId: string | null;
  arfHeaders: Record<string, string>;
}

export interface DsnReport {
  kind: 'dsn';
  finalRecipient: string | null;
  status: string | null;
  action: string | null;
  diagnosticCode: string | null;
  reportingMta: string | null;
  originalEnvelopeId: string | null;
  permanent: boolean;
}

export interface UnstructuredReport {
  kind: 'unstructured';
  contentType: string | null;
  from: string | null;
  subject: string | null;
  bodyPreview: string;
}

export type ParsedComplaint = ArfReport | DsnReport | UnstructuredReport;

interface ParsedPart {
  headers: Record<string, string>;
  body: string;
}

function splitHeadersAndBody(raw: string): { headers: Record<string, string>; body: string } {
  const idx = raw.indexOf('\r\n\r\n');
  const split = idx >= 0 ? idx : raw.indexOf('\n\n');
  if (split < 0) {
    return { headers: parseHeaders(raw), body: '' };
  }
  const headerBlob = raw.slice(0, split);
  const bodyStart = raw.slice(split, split + 4) === '\r\n\r\n' ? split + 4 : split + 2;
  return { headers: parseHeaders(headerBlob), body: raw.slice(bodyStart) };
}

function parseHeaders(blob: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!blob) return out;
  // Unfold CRLF + WSP continuation per RFC 5322 §2.2.3.
  const unfolded = blob.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    out[k] = v;
  }
  return out;
}

function parseContentTypeBoundary(ct: string | undefined): string | null {
  if (!ct) return null;
  const m = /boundary\s*=\s*("?)([^";]+)\1/i.exec(ct);
  return m && m[2] ? m[2] : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitMultipart(body: string, boundary: string): ParsedPart[] {
  const delim = '--' + boundary;
  const after = body.indexOf(delim);
  if (after < 0) return [];
  const rest = body.slice(after);
  const tokens = rest.split(new RegExp(`\\r?\\n?${escapeRegExp(delim)}(?:--)?\\r?\\n?`));
  const parts: ParsedPart[] = [];
  for (const t of tokens) {
    const trimmed = t.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    if (!trimmed) continue;
    if (trimmed === '--') continue;
    parts.push(splitHeadersAndBody(trimmed));
  }
  return parts.filter((p) => Object.keys(p.headers).length > 0);
}

export function parseComplaint(raw: string): ParsedComplaint {
  const top = splitHeadersAndBody(raw);
  const ct = top.headers['content-type'] ?? '';
  const lowerCt = ct.toLowerCase();

  if (lowerCt.includes('multipart/report')) {
    const boundary = parseContentTypeBoundary(ct);
    if (!boundary) return makeUnstructured(top);
    const parts = splitMultipart(top.body, boundary);
    if (
      lowerCt.includes('report-type=feedback-report') ||
      lowerCt.includes('report-type="feedback-report"')
    ) {
      return parseArf(parts);
    }
    if (
      lowerCt.includes('report-type=delivery-status') ||
      lowerCt.includes('report-type="delivery-status"')
    ) {
      return parseDsn(parts);
    }
    for (const p of parts) {
      const partCt = (p.headers['content-type'] ?? '').toLowerCase();
      if (partCt.includes('message/feedback-report')) return parseArf(parts);
      if (partCt.includes('message/delivery-status')) return parseDsn(parts);
    }
  }

  return makeUnstructured(top);
}

function makeUnstructured(top: {
  headers: Record<string, string>;
  body: string;
}): UnstructuredReport {
  return {
    kind: 'unstructured',
    contentType: top.headers['content-type'] ?? null,
    from: top.headers['from'] ?? null,
    subject: top.headers['subject'] ?? null,
    bodyPreview: top.body.slice(0, 4000),
  };
}

function parseArf(parts: ParsedPart[]): ArfReport | UnstructuredReport {
  const fbPart = parts.find((p) =>
    (p.headers['content-type'] ?? '').toLowerCase().includes('message/feedback-report'),
  );
  if (!fbPart) {
    return makeUnstructured({ headers: parts[0]?.headers ?? {}, body: parts[0]?.body ?? '' });
  }
  const arfHeaders = parseHeaders(fbPart.body);
  const fbType = (arfHeaders['feedback-type'] ?? '').toLowerCase();
  const feedbackType: ArfFeedbackType =
    fbType === 'abuse' ||
    fbType === 'fraud' ||
    fbType === 'virus' ||
    fbType === 'auth-failure' ||
    fbType === 'opt-out'
      ? fbType
      : 'other';

  const origPart = parts.find((p) => {
    const ct = (p.headers['content-type'] ?? '').toLowerCase();
    return ct.includes('message/rfc822') || ct.includes('text/rfc822-headers');
  });
  let originalMessageId: string | null = null;
  if (origPart) {
    const origHeaders = parseHeaders(origPart.body);
    originalMessageId = origHeaders['message-id'] ?? null;
  }

  return {
    kind: 'arf',
    feedbackType,
    originalRcptTo: arfHeaders['original-rcpt-to'] ?? null,
    originalMailFrom: arfHeaders['original-mail-from'] ?? null,
    userAgent: arfHeaders['user-agent'] ?? null,
    reportingMta: arfHeaders['reporting-mta'] ?? null,
    arrivalDate: arfHeaders['arrival-date'] ?? null,
    originalMessageId,
    arfHeaders,
  };
}

function parseDsn(parts: ParsedPart[]): DsnReport | UnstructuredReport {
  const dsPart = parts.find((p) =>
    (p.headers['content-type'] ?? '').toLowerCase().includes('message/delivery-status'),
  );
  if (!dsPart) {
    return makeUnstructured({ headers: parts[0]?.headers ?? {}, body: parts[0]?.body ?? '' });
  }
  const blocks = dsPart.body.split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0);
  const perMessage = blocks[0] ? parseHeaders(blocks[0]) : {};
  const perRecipient = blocks[1] ? parseHeaders(blocks[1]) : {};
  const status = (perRecipient['status'] ?? '').trim() || null;
  const finalRcpt = perRecipient['final-recipient'] ?? null;
  let finalRecipient: string | null = null;
  if (finalRcpt) {
    const semi = finalRcpt.indexOf(';');
    finalRecipient = (semi >= 0 ? finalRcpt.slice(semi + 1) : finalRcpt).trim();
  }
  return {
    kind: 'dsn',
    finalRecipient,
    status,
    action: (perRecipient['action'] ?? '').trim() || null,
    diagnosticCode: (perRecipient['diagnostic-code'] ?? '').trim() || null,
    reportingMta: (perMessage['reporting-mta'] ?? '').trim() || null,
    originalEnvelopeId: (perMessage['original-envelope-id'] ?? '').trim() || null,
    permanent: status ? status.startsWith('5') : false,
  };
}

/**
 * Convenience helper: extract the address that should be added to the
 * suppression list for a parsed complaint, plus the address that should be
 * credited as the offending SENDER (for W2c sender_abuse_profile).
 *
 * Returns `null` for the recipient field when the structure doesn't carry
 * one (e.g. unstructured prose forwarded to abuse@ without an inner From:).
 */
export function suppressionTargets(complaint: ParsedComplaint): {
  recipientAddress: string | null;
  senderAddress: string | null;
  reason: 'spam_complaint' | 'hard_bounce' | null;
} {
  if (complaint.kind === 'arf') {
    return {
      recipientAddress: complaint.originalRcptTo,
      senderAddress: complaint.originalMailFrom,
      reason: 'spam_complaint',
    };
  }
  if (complaint.kind === 'dsn' && complaint.permanent) {
    return {
      recipientAddress: complaint.finalRecipient,
      senderAddress: null,
      reason: 'hard_bounce',
    };
  }
  return { recipientAddress: null, senderAddress: null, reason: null };
}
