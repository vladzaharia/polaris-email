// JSON <-> RFC822 bridge for the unified Message shape.
//
// `mimeToMessage()` parses canonical RFC822 bytes and emits the unified Message
// JSON used by both inbound webhooks and the GET /v1/messages API. Attachment
// metadata only - bodies are populated at read time (inline-small /
// url-large strategy).
//
// `composeFromJson()` does the reverse: takes a SendRequest and produces
// canonical RFC822 bytes suitable for handing to processMessage().

import { parseStrict, serialize, type ParsedMime, type Header } from './canonicalize.js';

export interface MessageAttachmentMeta {
  filename: string;
  content_type: string;
  size_bytes: number;
  content_base64?: string;
  content_url?: string;
}

export interface UnifiedMessage {
  id: string;
  mailbox_id: string;
  direction: 'in' | 'out';
  status: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments: MessageAttachmentMeta[];
  header_message_id?: string;
  thread_id?: string;
  auth?: { spf?: string; dkim?: string; dmarc?: string; remote_ip?: string };
  body_bytes?: number;
  attachments_total_bytes?: number;
  received_at_daemon?: string;
  received_at_api?: string;
  queued_at?: string;
  sending_at?: string;
  sent_at?: string;
  delivered_at?: string;
  failed_at?: string;
  bounce_metadata?: unknown;
  last_error?: string;
  created_at: string;
}

export interface MessageRowMeta {
  id: string;
  mailbox_id: string;
  direction: 'in' | 'out';
  status: string;
  thread_id?: string | null;
  header_message_id?: string | null;
  auth_spf?: string | null;
  auth_dkim?: string | null;
  auth_dmarc?: string | null;
  auth_remote_ip?: string | null;
  body_bytes?: number | null;
  attachments_total_bytes?: number | null;
  received_at_daemon?: string | null;
  received_at_api?: string | null;
  queued_at?: string | null;
  sending_at?: string | null;
  sent_at?: string | null;
  delivered_at?: string | null;
  failed_at?: string | null;
  bounce_metadata?: string | null;
  last_error?: string | null;
  created_at: string;
}

export interface SendRequestLike {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: { filename: string; content_type: string; content_base64: string }[];
  reply_to?: string;
}

const ADDR_RE = /(?:"[^"]*"\s*)?(?:<([^>]+)>|([^,;<>\s]+@[^,;<>\s]+))/g;
function parseAddressList(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  let m: RegExpExecArray | null;
  ADDR_RE.lastIndex = 0;
  while ((m = ADDR_RE.exec(value))) {
    const a = (m[1] ?? m[2] ?? '').trim().toLowerCase();
    if (a) out.push(a);
  }
  return out;
}
function parseFirstAddress(value: string | undefined): string {
  return parseAddressList(value)[0] ?? '';
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
      .replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    return new TextEncoder().encode(decoded);
  }
  const out = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) out[i] = body.charCodeAt(i) & 0xff;
  return out;
}

interface BodySummary {
  text?: string;
  html?: string;
  attachments: MessageAttachmentMeta[];
  body_bytes: number;
  attachments_total_bytes: number;
}

function splitHeadersBodyText(text: string): { headerStr: string; body: string } {
  const sep = text.indexOf('\r\n\r\n');
  if (sep >= 0) return { headerStr: text.slice(0, sep), body: text.slice(sep + 4) };
  const sep2 = text.indexOf('\n\n');
  if (sep2 >= 0) return { headerStr: text.slice(0, sep2), body: text.slice(sep2 + 2) };
  return { headerStr: text, body: '' };
}

function parseSubHeaders(s: string): { name: string; value: string }[] {
  const lines = s.split(/\r?\n/);
  const out: { name: string; value: string }[] = [];
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

function getSubHeader(
  headers: { name: string; value: string }[],
  name: string,
): string | undefined {
  const n = name.toLowerCase();
  for (const h of headers) if (h.name === n) return h.value;
  return undefined;
}

function walkPartsWithHeaders(
  body: string,
  topContentType: string,
  topXfer: string,
  summary: BodySummary,
): void {
  const ct = parseContentType(topContentType);
  if (!(ct.type.startsWith('multipart/') && ct.boundary)) {
    const decoded = decodePart(body, topXfer);
    if (ct.type === 'text/html') {
      summary.html = new TextDecoder(ct.charset).decode(decoded);
      summary.body_bytes += decoded.byteLength;
    } else if (ct.type.startsWith('text/')) {
      summary.text = new TextDecoder(ct.charset).decode(decoded);
      summary.body_bytes += decoded.byteLength;
    } else {
      summary.attachments.push({
        filename: 'attachment',
        content_type: ct.type,
        size_bytes: decoded.byteLength,
      });
      summary.attachments_total_bytes += decoded.byteLength;
    }
    return;
  }
  const boundary = ct.boundary;
  const delim = '--' + boundary;
  const end = delim + '--';
  const parts: string[] = [];
  let i = body.indexOf(delim);
  if (i < 0) return;
  while (i >= 0) {
    const next = body.indexOf(delim, i + delim.length);
    if (next < 0) break;
    const chunk = body
      .slice(i + delim.length, next)
      .replace(/^\r?\n/, '')
      .replace(/\r?\n$/, '');
    parts.push(chunk);
    if (body.indexOf(end, next) === next) break;
    i = next;
  }
  for (const p of parts) {
    const { headerStr, body: pbody } = splitHeadersBodyText(p);
    const subHeaders = parseSubHeaders(headerStr);
    const subCt = getSubHeader(subHeaders, 'content-type') ?? 'text/plain';
    const subDisp = getSubHeader(subHeaders, 'content-disposition') ?? '';
    const subXfer = (getSubHeader(subHeaders, 'content-transfer-encoding') ?? '').toLowerCase();
    const inner = parseContentType(subCt);
    if (inner.type.startsWith('multipart/') && inner.boundary) {
      walkPartsWithHeaders(pbody, subCt, subXfer, summary);
      continue;
    }
    const filenameMatch =
      subDisp.match(/filename\*?=["']?([^;"']+)/i) ?? subCt.match(/name=["']?([^;"']+)/i);
    const decoded = decodePart(pbody, subXfer);
    if (filenameMatch || /^application\/|image\/|video\/|audio\//.test(inner.type)) {
      summary.attachments.push({
        filename: (filenameMatch?.[1] ?? 'attachment').slice(0, 255),
        content_type: inner.type,
        size_bytes: decoded.byteLength,
      });
      summary.attachments_total_bytes += decoded.byteLength;
    } else if (inner.type === 'text/html' && !summary.html) {
      summary.html = new TextDecoder(inner.charset).decode(decoded);
      summary.body_bytes += decoded.byteLength;
    } else if (inner.type.startsWith('text/') && !summary.text) {
      summary.text = new TextDecoder(inner.charset).decode(decoded);
      summary.body_bytes += decoded.byteLength;
    }
  }
}

function decodeMimeWord(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (_: string, charset: string, enc: string, payload: string) => {
      try {
        if (enc.toUpperCase() === 'B') {
          const bin = atob(payload);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return new TextDecoder(charset).decode(bytes);
        }
        return payload
          .replace(/_/g, ' ')
          .replace(/=([0-9A-Fa-f]{2})/g, (_2, h: string) => String.fromCharCode(parseInt(h, 16)));
      } catch {
        return payload;
      }
    },
  );
}

export interface ParsedMimeSummary {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string;
  headerMessageId?: string;
  references?: string;
  inReplyTo?: string;
  text?: string;
  html?: string;
  attachments: MessageAttachmentMeta[];
  body_bytes: number;
  attachments_total_bytes: number;
  headers: Record<string, string>;
}

/**
 * Summarise canonical RFC822 bytes into the body fields and headers we
 * surface on the Message JSON. Used by both `mimeToMessage` and by
 * processMessage to compute body/attachment byte totals + thread headers.
 */
export function summarizeMime(raw: Uint8Array): ParsedMimeSummary {
  const parsed: ParsedMime = parseStrict(raw);
  const headerMap: Record<string, string> = {};
  for (const h of parsed.headers) headerMap[h.nameLc] = h.value;

  const contentType = headerMap['content-type'] ?? 'text/plain; charset=us-ascii';
  const topXfer = (headerMap['content-transfer-encoding'] ?? '').toLowerCase();
  const bodyText = new TextDecoder('latin1').decode(parsed.body);

  const summary: BodySummary = {
    attachments: [],
    body_bytes: 0,
    attachments_total_bytes: 0,
  };
  walkPartsWithHeaders(bodyText, contentType, topXfer, summary);

  const out: ParsedMimeSummary = {
    from: parseFirstAddress(headerMap['from']),
    to: parseAddressList(headerMap['to']),
    cc: parseAddressList(headerMap['cc']),
    bcc: parseAddressList(headerMap['bcc']),
    attachments: summary.attachments,
    body_bytes: summary.body_bytes,
    attachments_total_bytes: summary.attachments_total_bytes,
    headers: headerMap,
  };
  const subj = decodeMimeWord(headerMap['subject']);
  if (subj !== undefined) out.subject = subj;
  if (headerMap['message-id']) out.headerMessageId = headerMap['message-id'];
  if (headerMap['references']) out.references = headerMap['references'];
  if (headerMap['in-reply-to']) out.inReplyTo = headerMap['in-reply-to'];
  if (summary.text !== undefined) out.text = summary.text;
  if (summary.html !== undefined) out.html = summary.html;
  return out;
}

/**
 * Build the unified Message JSON for a stored row. Attachment bodies are
 * intentionally omitted - those are populated at API GET time using the
 * inline-small / url-large strategy.
 */
export function mimeToMessage(raw: Uint8Array, row: MessageRowMeta): UnifiedMessage {
  const s = summarizeMime(raw);
  const msg: UnifiedMessage = {
    id: row.id,
    mailbox_id: row.mailbox_id,
    direction: row.direction,
    status: row.status,
    from: s.from,
    to: s.to,
    attachments: s.attachments,
    created_at: row.created_at,
  };
  if (s.cc.length) msg.cc = s.cc;
  if (s.bcc.length) msg.bcc = s.bcc;
  if (s.subject !== undefined) msg.subject = s.subject;
  if (s.text !== undefined) msg.text = s.text;
  if (s.html !== undefined) msg.html = s.html;
  if (Object.keys(s.headers).length) msg.headers = s.headers;
  if (s.headerMessageId) msg.header_message_id = s.headerMessageId;
  if (row.thread_id) msg.thread_id = row.thread_id;
  if (row.header_message_id && !msg.header_message_id)
    msg.header_message_id = row.header_message_id;
  const auth: NonNullable<UnifiedMessage['auth']> = {};
  if (row.auth_spf) auth.spf = row.auth_spf;
  if (row.auth_dkim) auth.dkim = row.auth_dkim;
  if (row.auth_dmarc) auth.dmarc = row.auth_dmarc;
  if (row.auth_remote_ip) auth.remote_ip = row.auth_remote_ip;
  if (Object.keys(auth).length) msg.auth = auth;
  if (row.body_bytes != null) msg.body_bytes = row.body_bytes;
  if (row.attachments_total_bytes != null)
    msg.attachments_total_bytes = row.attachments_total_bytes;
  if (row.received_at_daemon) msg.received_at_daemon = row.received_at_daemon;
  if (row.received_at_api) msg.received_at_api = row.received_at_api;
  if (row.queued_at) msg.queued_at = row.queued_at;
  if (row.sending_at) msg.sending_at = row.sending_at;
  if (row.sent_at) msg.sent_at = row.sent_at;
  if (row.delivered_at) msg.delivered_at = row.delivered_at;
  if (row.failed_at) msg.failed_at = row.failed_at;
  if (row.bounce_metadata) {
    try {
      msg.bounce_metadata = JSON.parse(row.bounce_metadata);
    } catch {
      msg.bounce_metadata = row.bounce_metadata;
    }
  }
  if (row.last_error) msg.last_error = row.last_error;
  return msg;
}

function b64encode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function randomBoundary(): string {
  const r = new Uint8Array(12);
  crypto.getRandomValues(r);
  let s = '';
  for (const b of r) s += b.toString(16).padStart(2, '0');
  return `----=_polaris_${s}`;
}

function encodeHeaderValue(v: string): string {
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  const bytes = new TextEncoder().encode(v);
  return `=?utf-8?B?${b64encode(bytes)}?=`;
}

/**
 * Compose canonical RFC822 bytes from a JSON SendRequest. Output is fed
 * through `parseStrict()` afterwards by `processMessage()` for re-validation.
 */
export function composeFromJson(req: SendRequestLike): Uint8Array {
  const now = new Date().toUTCString();
  const headerList: Header[] = [];
  headerList.push({ nameLc: 'date', name: 'Date', value: now });
  headerList.push({ nameLc: 'from', name: 'From', value: req.from });
  headerList.push({ nameLc: 'to', name: 'To', value: req.to.join(', ') });
  if (req.cc?.length) headerList.push({ nameLc: 'cc', name: 'Cc', value: req.cc.join(', ') });
  if (req.bcc?.length) headerList.push({ nameLc: 'bcc', name: 'Bcc', value: req.bcc.join(', ') });
  if (req.reply_to) headerList.push({ nameLc: 'reply-to', name: 'Reply-To', value: req.reply_to });
  if (req.subject !== undefined)
    headerList.push({ nameLc: 'subject', name: 'Subject', value: encodeHeaderValue(req.subject) });
  headerList.push({ nameLc: 'mime-version', name: 'MIME-Version', value: '1.0' });
  if (req.headers) {
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (headerList.some((h) => h.nameLc === lk)) continue;
      headerList.push({ nameLc: lk, name: k, value: encodeHeaderValue(v) });
    }
  }

  const hasAttachments = !!(req.attachments && req.attachments.length);
  const hasHtml = !!req.html;
  const hasText = !!req.text;

  let body: Uint8Array;
  if (hasAttachments) {
    const outerBoundary = randomBoundary();
    headerList.push({
      nameLc: 'content-type',
      name: 'Content-Type',
      value: `multipart/mixed; boundary="${outerBoundary}"`,
    });
    const parts: string[] = [];
    if (hasHtml && hasText) {
      const altBoundary = randomBoundary();
      parts.push(
        `--${outerBoundary}\r\nContent-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n`,
      );
      parts.push(
        `--${altBoundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${req.text}\r\n`,
      );
      parts.push(
        `--${altBoundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${req.html}\r\n`,
      );
      parts.push(`--${altBoundary}--\r\n`);
    } else if (hasHtml) {
      parts.push(
        `--${outerBoundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${req.html}\r\n`,
      );
    } else {
      parts.push(
        `--${outerBoundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${req.text ?? ''}\r\n`,
      );
    }
    for (const a of req.attachments!) {
      const wrapped = a.content_base64.replace(/\s+/g, '').replace(/(.{76})/g, '$1\r\n');
      parts.push(
        `--${outerBoundary}\r\nContent-Type: ${a.content_type}; name="${a.filename}"\r\nContent-Disposition: attachment; filename="${a.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrapped}\r\n`,
      );
    }
    parts.push(`--${outerBoundary}--\r\n`);
    body = new TextEncoder().encode(parts.join(''));
  } else if (hasHtml && hasText) {
    const altBoundary = randomBoundary();
    headerList.push({
      nameLc: 'content-type',
      name: 'Content-Type',
      value: `multipart/alternative; boundary="${altBoundary}"`,
    });
    const parts = [
      `--${altBoundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${req.text}\r\n`,
      `--${altBoundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${req.html}\r\n`,
      `--${altBoundary}--\r\n`,
    ];
    body = new TextEncoder().encode(parts.join(''));
  } else if (hasHtml) {
    headerList.push({
      nameLc: 'content-type',
      name: 'Content-Type',
      value: 'text/html; charset=utf-8',
    });
    headerList.push({
      nameLc: 'content-transfer-encoding',
      name: 'Content-Transfer-Encoding',
      value: '8bit',
    });
    body = new TextEncoder().encode(req.html ?? '');
  } else {
    headerList.push({
      nameLc: 'content-type',
      name: 'Content-Type',
      value: 'text/plain; charset=utf-8',
    });
    headerList.push({
      nameLc: 'content-transfer-encoding',
      name: 'Content-Transfer-Encoding',
      value: '8bit',
    });
    body = new TextEncoder().encode(req.text ?? '');
  }

  const parsed: ParsedMime = { headers: headerList, body };
  return serialize(parsed);
}
