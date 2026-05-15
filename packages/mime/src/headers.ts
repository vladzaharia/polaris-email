// Lightweight header-string helpers used to parse free-form RFC 5322 header
// values (address lists, encoded-words, Authentication-Results). These are
// intentionally separate from the strict canonicalizer in `canonicalize.ts`:
// the canonicalizer rejects policy violations at ingress, while these helpers
// extract semantic fields from already-accepted bytes.
//
// Public API: any caller (services/in, future consumers) that needs to read
// address fields or subject lines from existing headers can import these
// directly instead of re-implementing the regexes.

const ADDR_RE = /(?:"[^"]*"\s*)?(?:<([^>]+)>|([^,;<>\s]+@[^,;<>\s]+))/g;

/**
 * Extract a flat list of normalized (lower-cased, angle-stripped) email
 * addresses from an RFC 5322 address-list header value like `To:` / `Cc:`.
 * Returns an empty array for null/undefined/empty input.
 */
export function parseAddressList(value: string | null | undefined): string[] {
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

/**
 * Extract the first normalized address from an address-list header value.
 * Returns `null` when no addresses are present.
 */
export function parseFirstAddress(value: string | null | undefined): string | null {
  return parseAddressList(value)[0] ?? null;
}

/**
 * Decode RFC 2047 encoded-words (`=?charset?B?...?=` / `=?charset?Q?...?=`)
 * embedded in a header value (typically `Subject:`). Returns the input
 * verbatim when no encoded-words are present. Returns `null` for null input.
 */
export function decodeMimeWord(value: string | null | undefined): string | null {
  if (value == null) return null;
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

/** Parsed pieces of an RFC 8601 `Authentication-Results:` header. */
export interface AuthResults {
  spf?: string;
  dkim?: string;
  dmarc?: string;
}

/**
 * Extract `spf=` / `dkim=` / `dmarc=` verdicts from an
 * `Authentication-Results:` header value. Each verdict is lower-cased.
 * Returns an empty object if none are found.
 */
export function parseAuthResults(value: string | null | undefined): AuthResults {
  const out: AuthResults = {};
  if (!value) return out;
  for (const part of value.split(';')) {
    const m = part.trim().match(/^(spf|dkim|dmarc)\s*=\s*(\w+)/i);
    if (m) {
      const k = m[1]!.toLowerCase() as 'spf' | 'dkim' | 'dmarc';
      out[k] = m[2]!.toLowerCase();
    }
  }
  return out;
}
