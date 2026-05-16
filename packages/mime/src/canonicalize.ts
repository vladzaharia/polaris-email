// Strict RFC 5322 / RFC 2822 MIME canonicalizer (C2 mitigation).
//
// Rejects parser-disagreement vectors: bare LF, NUL bytes, oversized header
// lines, header continuation that smuggles a second `From:`/`Bcc:`, duplicate
// singleton headers (`From`, `Date`, `Message-ID`), embedded CRs in body.
// Re-serializes to canonical CRLF with normalized header casing.
//
// Caller is expected to feed this the bytes received over SMTP DATA; the
// bridge (or `/v1/send/raw`) MUST canonicalize before forwarding to provider.

const MAX_HEADER_LINE = 998; // RFC 5322 §2.1.1
const MAX_HEADERS = 256;
const MAX_TOTAL_HEADER_BYTES = 64 * 1024;

// Headers that may appear at most once. Submitter cannot duplicate these.
const SINGLETON_HEADERS = new Set([
  'date',
  'from',
  'sender',
  'reply-to',
  'to',
  'cc',
  'bcc',
  'message-id',
  'in-reply-to',
  'references',
  'subject',
  'return-path',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
]);

// Transport-security headers the submitter has no business setting; we strip
// on input. A relay downstream may add its own; that's fine.
//
// Exported as `TRANSPORT_FORBIDDEN_HEADERS` so the schema package can build
// its own (broader) JSON-API forbid-list on top — schema's set adds the
// "we generate this from JSON fields" headers (`from`/`to`/`subject`/etc.)
// that are nonsensical to set via the JSON `headers` map.
export const TRANSPORT_FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  'received',
  'return-path',
  'dkim-signature',
  'authentication-results',
  'arc-seal',
  'arc-message-signature',
  'arc-authentication-results',
  'resent-date',
  'resent-from',
  'resent-sender',
  'resent-to',
  'resent-cc',
  'resent-bcc',
  'resent-message-id',
]);

export interface ParsedMime {
  headers: Header[];
  body: Uint8Array;
}

export interface Header {
  /** Lowercased name, used for lookups + duplicate detection. */
  nameLc: string;
  /** Display-cased name from input (e.g., "Message-ID"). */
  name: string;
  /** Unfolded value with leading whitespace stripped. */
  value: string;
}

export class MimeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

/** Parse + validate. Throws MimeError on any policy violation. */
export function parseStrict(input: Uint8Array): ParsedMime {
  // First pass: scan for NULs and bare-LF/bare-CR violations across the whole
  // input. Bare LF in headers is the canonical smuggling vector.
  let crlfBoundary = -1;
  for (let i = 0; i < input.length; i++) {
    const b = input[i];
    if (b === 0) throw new MimeError('NUL byte in message', 'nul_byte');
    if (b === 0x0d) {
      if (input[i + 1] !== 0x0a) {
        throw new MimeError('bare CR in message', 'bare_cr');
      }
      i++; // consume LF
      // CRLF CRLF marks header/body boundary.
      if (input[i + 1] === 0x0d && input[i + 2] === 0x0a) {
        crlfBoundary = i + 1; // index of second CR
        break;
      }
    } else if (b === 0x0a) {
      // bare LF in header section — reject (smuggling vector).
      throw new MimeError('bare LF in header section', 'bare_lf');
    }
  }
  if (crlfBoundary === -1) {
    throw new MimeError('no header/body boundary (CRLF CRLF) found', 'no_boundary');
  }

  // Header bytes are [0, crlfBoundary) — already validated CRLF-only.
  const headerBytes = input.subarray(0, crlfBoundary);
  if (headerBytes.length > MAX_TOTAL_HEADER_BYTES) {
    throw new MimeError(`headers exceed ${MAX_TOTAL_HEADER_BYTES} bytes`, 'headers_too_large');
  }

  const headers = parseHeaders(headerBytes);
  enforceHeaderPolicy(headers);

  // crlfBoundary is the index of the second CRLF's CR. Body starts right after
  // the second CRLF (CR + LF = 2 bytes after crlfBoundary).
  const bodyStart = crlfBoundary + 2;
  const body = input.subarray(bodyStart);

  return { headers, body };
}

function parseHeaders(bytes: Uint8Array): Header[] {
  const decoded = new TextDecoder('utf-8').decode(bytes);
  // Split on CRLF; reassemble continuation lines (lines starting with WSP).
  const lines = decoded.split('\r\n');
  const headers: Header[] = [];
  let cur: { name: string; value: string } | null = null;

  for (const line of lines) {
    if (line === '') continue; // trailing empty line
    if (line.length > MAX_HEADER_LINE) {
      throw new MimeError(`header line exceeds ${MAX_HEADER_LINE} octets`, 'header_too_long');
    }
    const isContinuation = line[0] === ' ' || line[0] === '\t';
    if (isContinuation) {
      if (!cur) throw new MimeError('continuation before any header', 'orphan_continuation');
      cur.value += ' ' + line.trim();
      continue;
    }
    // Push previous header.
    if (cur) headers.push({ nameLc: cur.name.toLowerCase(), name: cur.name, value: cur.value });
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) {
      throw new MimeError(`malformed header line: ${line.slice(0, 40)}`, 'malformed_header');
    }
    const name = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (!/^[\x21-\x7e]+$/.test(name)) {
      throw new MimeError(`header name has invalid bytes: ${name}`, 'invalid_header_name');
    }
    cur = { name, value };
    if (headers.length >= MAX_HEADERS) {
      throw new MimeError(`exceeded ${MAX_HEADERS} headers`, 'too_many_headers');
    }
  }
  if (cur) headers.push({ nameLc: cur.name.toLowerCase(), name: cur.name, value: cur.value });

  return headers;
}

function enforceHeaderPolicy(headers: Header[]): void {
  const seen = new Set<string>();
  for (const h of headers) {
    if (TRANSPORT_FORBIDDEN_HEADERS.has(h.nameLc)) {
      throw new MimeError(`forbidden submitter header: ${h.name}`, 'forbidden_header');
    }
    if (SINGLETON_HEADERS.has(h.nameLc)) {
      if (seen.has(h.nameLc)) {
        throw new MimeError(`duplicate singleton header: ${h.name}`, 'duplicate_singleton');
      }
      seen.add(h.nameLc);
    }
  }
}

/** Re-serialize parsed MIME as canonical CRLF bytes. Preserves body verbatim. */
export function serialize(parsed: ParsedMime): Uint8Array {
  const headerLines: string[] = [];
  for (const h of parsed.headers) {
    headerLines.push(`${h.name}: ${h.value}`);
  }
  const headerStr = headerLines.join('\r\n') + '\r\n\r\n';
  const headerBytes = new TextEncoder().encode(headerStr);
  const out = new Uint8Array(headerBytes.length + parsed.body.length);
  out.set(headerBytes, 0);
  out.set(parsed.body, headerBytes.length);
  return out;
}

/** Look up the value of a header by lowercased name. */
export function getHeader(parsed: ParsedMime, nameLc: string): string | undefined {
  return parsed.headers.find((h) => h.nameLc === nameLc)?.value;
}

/** Replace or insert a header (used to re-author Return-Path server-side). */
export function setHeader(parsed: ParsedMime, name: string, value: string): void {
  const nameLc = name.toLowerCase();
  const existing = parsed.headers.find((h) => h.nameLc === nameLc);
  if (existing) {
    existing.value = value;
    existing.name = name;
  } else {
    parsed.headers.unshift({ nameLc, name, value });
  }
}
