// Minimal RFC822 / MIME parser sufficient for polaris-email-in.
// Lives inline (no postal-mime dependency at runtime) so the Worker has zero supply-chain reach
// for inbound parsing. Supports headers, single-part + multipart, base64/quoted-printable, and
// attachments with filename + content-type.

export interface ParsedHeader {
  name: string;
  value: string;
}

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  size: number;
  /** Decoded bytes. */
  bytes: Uint8Array;
}

export interface ParsedMime {
  headers: ParsedHeader[];
  from: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
  date: string | null;
  messageId: string | null;
  textBody: string | null;
  htmlBody: string | null;
  attachments: ParsedAttachment[];
  /** Headers from Cloudflare Email Routing for SPF/DKIM/DMARC. */
  authResults: { spf?: string; dkim?: string; dmarc?: string; remoteIp?: string };
}

const MAX_DEPTH = 10;
const MAX_HEADERS = 200;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_PART_BYTES = 25 * 1024 * 1024;

export class ParseError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function parseMime(raw: Uint8Array): Promise<ParsedMime> {
  if (raw.byteLength > MAX_PART_BYTES) throw new ParseError('too_large', 'message exceeds cap');
  const text = new TextDecoder('latin1').decode(raw);
  const { headers, body } = splitHeadersBody(text);
  if (headers.length === 0) throw new ParseError('no_headers', 'empty headers');
  if (headers.length > MAX_HEADERS) throw new ParseError('too_many_headers', '');
  const ct = getHeader(headers, 'content-type') ?? 'text/plain; charset=us-ascii';
  const { type, boundary, charset } = parseContentType(ct);
  let textBody: string | null = null;
  let htmlBody: string | null = null;
  const attachments: ParsedAttachment[] = [];
  if (type.startsWith('multipart/') && boundary) {
    await walkParts(body, boundary, 0, (part) => {
      const subCt = getHeader(part.headers, 'content-type') ?? 'text/plain';
      const subType = parseContentType(subCt).type;
      const disp = getHeader(part.headers, 'content-disposition') ?? '';
      const filenameMatch =
        disp.match(/filename\*?=["']?([^;"']+)/i) ?? subCt.match(/name=["']?([^;"']+)/i);
      const xfer = (getHeader(part.headers, 'content-transfer-encoding') ?? '').toLowerCase();
      const decoded = decodePart(part.body, xfer);
      if (filenameMatch || /^application\/|image\/|video\/|audio\//.test(subType)) {
        attachments.push({
          filename: (filenameMatch?.[1] ?? 'attachment').slice(0, 255),
          contentType: subType,
          size: decoded.byteLength,
          bytes: decoded,
        });
      } else if (subType === 'text/html' && htmlBody == null) {
        htmlBody = new TextDecoder(parseContentType(subCt).charset).decode(decoded);
      } else if (subType.startsWith('text/') && textBody == null) {
        textBody = new TextDecoder(parseContentType(subCt).charset).decode(decoded);
      }
    });
  } else {
    const xfer = (getHeader(headers, 'content-transfer-encoding') ?? '').toLowerCase();
    const decoded = decodePart(body, xfer);
    const decodedStr = new TextDecoder(charset).decode(decoded);
    if (type === 'text/html') htmlBody = decodedStr;
    else textBody = decodedStr;
  }
  const auth = parseAuthResults(getHeader(headers, 'authentication-results') ?? '');
  return {
    headers,
    from: parseFirstAddress(getHeader(headers, 'from')),
    to: parseAddressList(getHeader(headers, 'to')),
    cc: parseAddressList(getHeader(headers, 'cc')),
    subject: decodeMimeWord(getHeader(headers, 'subject')),
    date: getHeader(headers, 'date'),
    messageId: getHeader(headers, 'message-id'),
    textBody,
    htmlBody,
    attachments,
    authResults: {
      ...auth,
      ...(getHeader(headers, 'x-real-ip') ? { remoteIp: getHeader(headers, 'x-real-ip')! } : {}),
    },
  };
}

function splitHeadersBody(text: string): { headers: ParsedHeader[]; body: string } {
  const sep = text.indexOf('\r\n\r\n');
  const sep2 = sep < 0 ? text.indexOf('\n\n') : sep;
  const idx = sep < 0 ? sep2 : Math.min(sep, sep2 < 0 ? sep : sep2);
  if (idx < 0) {
    return { headers: parseHeaders(text), body: '' };
  }
  const hdr = text.slice(0, idx);
  const body = text.slice(idx + (text[idx] === '\r' ? 4 : 2));
  return { headers: parseHeaders(hdr), body };
}

function parseHeaders(s: string): ParsedHeader[] {
  if (s.length > MAX_HEADER_BYTES) throw new ParseError('headers_too_big', '');
  const lines = s.split(/\r?\n/);
  const out: ParsedHeader[] = [];
  for (const line of lines) {
    if (!line) continue;
    if (/^[\t ]/.test(line) && out.length) {
      out[out.length - 1]!.value += ' ' + line.trim();
      continue;
    }
    const m = line.match(/^([^:]+):\s?(.*)$/);
    if (!m) continue;
    out.push({ name: m[1]!.trim().toLowerCase(), value: (m[2] ?? '').trim() });
  }
  return out;
}

function getHeader(headers: ParsedHeader[], name: string): string | null {
  const n = name.toLowerCase();
  for (const h of headers) if (h.name === n) return h.value;
  return null;
}

function parseContentType(value: string): { type: string; boundary?: string; charset: string } {
  const parts = value.split(';').map((p) => p.trim());
  const type = (parts[0] ?? 'text/plain').toLowerCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const m = parts[i]!.match(/^([^=]+)=(?:"([^"]*)"|([^;]+))$/);
    if (m) params[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? '';
  }
  const result: { type: string; boundary?: string; charset: string } = {
    type,
    charset: params.charset ?? 'utf-8',
  };
  if (params.boundary) result.boundary = params.boundary;
  return result;
}

async function walkParts(
  body: string,
  boundary: string,
  depth: number,
  cb: (part: { headers: ParsedHeader[]; body: string }) => void,
): Promise<void> {
  if (depth >= MAX_DEPTH) throw new ParseError('depth_exceeded', '');
  const delim = '--' + boundary;
  const end = delim + '--';
  const parts: string[] = [];
  let i = body.indexOf(delim);
  if (i < 0) return;
  while (i >= 0) {
    const next = body.indexOf(delim, i + delim.length);
    if (next < 0) break;
    const chunk = body.slice(i + delim.length, next);
    if (chunk.startsWith(end.slice(delim.length))) break;
    parts.push(chunk.replace(/^\r?\n/, '').replace(/\r?\n$/, ''));
    if (next === body.indexOf(end)) break;
    i = next;
  }
  for (const p of parts) {
    const { headers, body: pbody } = splitHeadersBody(p);
    const ct = getHeader(headers, 'content-type') ?? '';
    const inner = parseContentType(ct);
    if (inner.type.startsWith('multipart/') && inner.boundary) {
      await walkParts(pbody, inner.boundary, depth + 1, cb);
    } else {
      cb({ headers, body: pbody });
    }
  }
}

function decodePart(body: string, xfer: string): Uint8Array {
  if (xfer === 'base64') {
    const cleaned = body.replace(/\s+/g, '');
    try {
      const bin = atob(cleaned);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return new TextEncoder().encode(body);
    }
  }
  if (xfer === 'quoted-printable') {
    const decoded = body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return new TextEncoder().encode(decoded);
  }
  const out = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) out[i] = body.charCodeAt(i) & 0xff;
  return out;
}

const ADDR_RE = /(?:"[^"]*"\s*)?(?:<([^>]+)>|([^,;<>\s]+@[^,;<>\s]+))/g;
function parseAddressList(value: string | null): string[] {
  if (!value) return [];
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = ADDR_RE.exec(value))) {
    const a = (m[1] ?? m[2] ?? '').trim().toLowerCase();
    if (a) out.push(a);
  }
  return out;
}
function parseFirstAddress(value: string | null): string | null {
  const list = parseAddressList(value);
  return list[0] ?? null;
}

function decodeMimeWord(value: string | null): string | null {
  if (!value) return null;
  return value.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (_, charset: string, enc: string, payload: string) => {
      try {
        if (enc.toUpperCase() === 'B') {
          const bin = atob(payload);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return new TextDecoder(charset).decode(bytes);
        }
        const decoded = payload
          .replace(/_/g, ' ')
          .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
        return decoded;
      } catch {
        return payload;
      }
    },
  );
}

function parseAuthResults(value: string): { spf?: string; dkim?: string; dmarc?: string } {
  const out: { spf?: string; dkim?: string; dmarc?: string } = {};
  for (const part of value.split(';')) {
    const m = part.trim().match(/^(spf|dkim|dmarc)\s*=\s*(\w+)/i);
    if (m) {
      const k = m[1]!.toLowerCase() as 'spf' | 'dkim' | 'dmarc';
      out[k] = m[2]!.toLowerCase();
    }
  }
  return out;
}
