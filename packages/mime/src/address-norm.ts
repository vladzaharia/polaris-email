// Address normalization for inbound routing matches (H2 mitigation).
//
// The inbound Worker dispatches recipient addresses to routing_rules via
// **exact-equality match on IDNA-normalized values**. Suffix matching is
// forbidden — it lets `acme.com` mail leak into a `mail.acme.com` route
// when the rule is `endsWith('.acme.com')`.
//
// This module normalizes addresses before comparison so encoded forms
// (Punycode, mixed-case, trailing dots, IDN homograph variants) all
// collapse to one canonical representation. Cyrillic 'а' (U+0430) and
// Latin 'a' (U+0061) MUST NOT compare equal under this normalizer —
// the two characters have different IDNA forms and we keep them
// distinguishable to prevent homograph attacks.

const TRAILING_DOT = /\.+$/;

export interface NormalizedAddress {
  /** Lower-cased local-part. */
  localPart: string;
  /** IDNA-normalized hostname (Punycode form). */
  domain: string;
  /** The whole address joined: `${localPart}@${domain}`. */
  full: string;
}

export class AddressError extends Error {
  constructor(
    message: string,
    public readonly code: 'no_at' | 'multi_at' | 'empty_local' | 'empty_domain' | 'idn_failed'
  ) {
    super(message);
  }
}

/**
 * Normalize an email address for exact-equality match. Throws AddressError
 * on any malformed input — callers should reject the message rather than
 * try to recover.
 */
export function normalizeAddress(addr: string): NormalizedAddress {
  if (!addr) throw new AddressError('empty address', 'empty_local');
  const at = addr.indexOf('@');
  if (at < 0) throw new AddressError('no @ in address', 'no_at');
  if (addr.indexOf('@', at + 1) >= 0) {
    throw new AddressError('multiple @ in address', 'multi_at');
  }
  const local = addr.slice(0, at).trim();
  let domain = addr
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(TRAILING_DOT, '');
  if (!local) throw new AddressError('empty local-part', 'empty_local');
  if (!domain) throw new AddressError('empty domain', 'empty_domain');

  // IDNA: convert Unicode domain to ASCII Punycode form. URL hostnames in
  // modern engines do this automatically, so leverage that.
  try {
    const u = new URL(`http://${domain}`);
    domain = u.hostname;
  } catch {
    throw new AddressError(`IDNA conversion failed: ${domain}`, 'idn_failed');
  }

  return { localPart: local, domain, full: `${local}@${domain}` };
}

/**
 * Compare two addresses for exact-equality after normalization. Use this
 * for routing_rules.address_pattern matching in the inbound Worker.
 *
 * Local-part comparison is case-insensitive — matches what nearly every
 * mailbox provider does in practice, even though RFC 5321 says local-part
 * is technically case-sensitive. Suppress hyphenation differences elsewhere.
 *
 * Returns false on any normalization failure (fail-closed).
 */
export function addressesEqual(a: string, b: string): boolean {
  try {
    const na = normalizeAddress(a);
    const nb = normalizeAddress(b);
    return na.localPart.toLowerCase() === nb.localPart.toLowerCase() && na.domain === nb.domain;
  } catch {
    return false;
  }
}

/**
 * Look up the most-specific matching domain row for a recipient. Used
 * alongside `email_senders.domain_id` resolution: walk up the labels of
 * the domain part, returning the longest-suffix match from the candidate
 * set. Returns null when nothing matches.
 *
 * Example: candidates = ['acme.com'], recipient on 'mail.acme.com' →
 * matches 'acme.com' iff caller knows the parent has wildcard_subdomains
 * (caller decides; this is just the match).
 */
export function longestSuffixMatch(
  recipientDomain: string,
  candidateDomains: ReadonlyArray<string>
): string | null {
  let normRecipient: string;
  try {
    normRecipient = normalizeAddress(`x@${recipientDomain}`).domain;
  } catch {
    return null;
  }
  // Sort candidates by descending length so the most specific match wins.
  const sorted = [...candidateDomains]
    .map((c) => {
      try {
        return normalizeAddress(`x@${c}`).domain;
      } catch {
        return c.toLowerCase();
      }
    })
    .sort((a, b) => b.length - a.length);
  for (const c of sorted) {
    if (normRecipient === c) return c;
    if (normRecipient.endsWith('.' + c)) return c;
  }
  return null;
}
