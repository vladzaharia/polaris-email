// Sender-allow-list enforcement (C1 mitigation).
//
// Caller has already parsed MIME via `parseStrict()`. This module verifies the
// MIME `From:` (and `Sender:` if present) and `Reply-To:` against the
// credential's `allowed_senders` list. The envelope `MAIL FROM` is checked
// separately by the API edge / submission bridge.

import type { ParsedMime } from './canonicalize.js';
import { getHeader } from './canonicalize.js';

export interface SenderPolicy {
  /** Full email addresses this principal is authorized to use as From/Sender. */
  allowedSenders: string[];
}

export class SenderPolicyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

/**
 * Extract a single email address from an RFC 5322 mailbox-list field. Returns
 * null on multi-mailbox lists; rejects when the list contains more than one
 * address (RFC 6854 multi-author From is rejected for security).
 */
export function extractSingleAddress(headerValue: string): string | null {
  // Naive but sufficient for the policy check: split on commas at the top level
  // and require exactly one entry. Group syntax (`Name: a@b, c@d;`) is rejected.
  if (headerValue.includes(';')) return null;
  const parts = splitAddressList(headerValue);
  if (parts.length !== 1) return null;
  return extractAddrSpec(parts[0]!);
}

function splitAddressList(s: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  let inQuote = false;
  for (const ch of s) {
    if (ch === '"') inQuote = !inQuote;
    if (!inQuote) {
      if (ch === '<') depth++;
      else if (ch === '>') depth = Math.max(0, depth - 1);
      else if (ch === ',' && depth === 0) {
        out.push(buf.trim());
        buf = '';
        continue;
      }
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function extractAddrSpec(mailbox: string): string | null {
  // mailbox forms: "Display Name <local@domain>" or just "local@domain"
  const angleStart = mailbox.lastIndexOf('<');
  const angleEnd = mailbox.lastIndexOf('>');
  if (angleStart >= 0 && angleEnd > angleStart) {
    return normalizeAddr(mailbox.slice(angleStart + 1, angleEnd));
  }
  return normalizeAddr(mailbox);
}

function normalizeAddr(s: string): string | null {
  const trimmed = s.trim().toLowerCase();
  if (!/^[^\s<>"]+@[^\s<>"]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Enforce that the message's authoring headers reference only addresses in
 * `policy.allowedSenders`. Throws on any violation.
 */
export function enforceSenderPolicy(mime: ParsedMime, policy: SenderPolicy): void {
  const allowed = new Set(policy.allowedSenders.map((a) => a.toLowerCase()));

  const fromValue = getHeader(mime, 'from');
  if (!fromValue) {
    throw new SenderPolicyError('missing From: header', 'missing_from');
  }
  const fromAddr = extractSingleAddress(fromValue);
  if (!fromAddr) {
    throw new SenderPolicyError('From: must contain exactly one mailbox', 'multi_mailbox_from');
  }
  if (!allowed.has(fromAddr)) {
    throw new SenderPolicyError(`From: ${fromAddr} not in allowed_senders`, 'from_not_allowed');
  }

  const senderValue = getHeader(mime, 'sender');
  if (senderValue) {
    const senderAddr = extractSingleAddress(senderValue);
    if (!senderAddr || !allowed.has(senderAddr)) {
      throw new SenderPolicyError(
        `Sender: ${senderAddr ?? '<malformed>'} not in allowed_senders`,
        'sender_not_allowed',
      );
    }
  }

  const replyTo = getHeader(mime, 'reply-to');
  if (replyTo) {
    const replyAddr = extractSingleAddress(replyTo);
    if (!replyAddr) {
      throw new SenderPolicyError('Reply-To: must be a single mailbox', 'multi_mailbox_reply_to');
    }
    if (!allowed.has(replyAddr)) {
      // Reply-To allowed if it's any address on a domain the principal can send from.
      // Conservative: require exact match.
      throw new SenderPolicyError(
        `Reply-To: ${replyAddr} not in allowed_senders`,
        'reply_to_not_allowed',
      );
    }
  }
}
