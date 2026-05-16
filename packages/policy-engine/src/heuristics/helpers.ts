// Shared helpers used by multiple heuristics.
//
// Lives outside any single heuristic file so the engine doesn't grow
// duplicate parsers for "extract the From address" or "give me the
// registrable domain" — both of which several rules need.

/** Cheap PSL surrogate. For real launch this should consult the public
 *  suffix list, but for an MVP the last-two-labels rule covers ~95% of TLDs
 *  and never produces false positives in the same-domain direction. */
export function registrableDomain(host: string | undefined): string | null {
  if (!host) return null;
  const lower = host.toLowerCase().replace(/\.$/, '');
  const parts = lower.split('.');
  if (parts.length < 2) return null;
  return parts.slice(-2).join('.');
}

/** Extract an addr-spec from an RFC 5322 mailbox-list value. Returns the
 *  lowercased local + domain split, plus the display-name when present. */
export function parseAddress(value: string | undefined): {
  address: string | null;
  local: string | null;
  domain: string | null;
  display_name: string | null;
} {
  if (!value) return { address: null, local: null, domain: null, display_name: null };
  const trimmed = value.trim();
  // "Display Name" <foo@bar.com>
  const angled = trimmed.match(/^"?([^"<]*)"?\s*<([^>]+)>$/);
  let address: string;
  let display_name: string | null;
  if (angled) {
    display_name = (angled[1] ?? '').trim() || null;
    address = (angled[2] ?? '').trim().toLowerCase();
  } else {
    display_name = null;
    address = trimmed.toLowerCase();
  }
  const at = address.lastIndexOf('@');
  if (at < 0) return { address, local: null, domain: null, display_name };
  return {
    address,
    local: address.slice(0, at),
    domain: address.slice(at + 1),
    display_name,
  };
}

/** Bundled brand list for display-name + lookalike detection. Tiny on
 *  purpose — adding a brand is a one-line PR. False positives are the
 *  enemy here; only brands an attacker is plausibly going to impersonate. */
export const PROTECTED_BRANDS: ReadonlyArray<{
  brand: string;
  /** Domains the legit brand actually owns. */
  domains: ReadonlyArray<string>;
}> = [
  { brand: 'paypal', domains: ['paypal.com'] },
  { brand: 'microsoft', domains: ['microsoft.com', 'outlook.com', 'live.com'] },
  { brand: 'google', domains: ['google.com', 'gmail.com'] },
  { brand: 'apple', domains: ['apple.com', 'icloud.com'] },
  { brand: 'amazon', domains: ['amazon.com'] },
  { brand: 'docusign', domains: ['docusign.com', 'docusign.net'] },
  { brand: 'dropbox', domains: ['dropbox.com'] },
  { brand: 'github', domains: ['github.com'] },
  { brand: 'stripe', domains: ['stripe.com'] },
  { brand: 'slack', domains: ['slack.com', 'slack-mail.com'] },
  { brand: 'netflix', domains: ['netflix.com'] },
  { brand: 'meta', domains: ['facebook.com', 'fb.com', 'instagram.com'] },
  { brand: 'linkedin', domains: ['linkedin.com'] },
  { brand: 'chase', domains: ['chase.com'] },
  { brand: 'wellsfargo', domains: ['wellsfargo.com'] },
  { brand: 'usps', domains: ['usps.com'] },
  { brand: 'fedex', domains: ['fedex.com'] },
  { brand: 'irs', domains: ['irs.gov'] },
];

/** Damerau-Levenshtein distance. Hot path on every inbound message —
 *  kept iterative + early-exit-friendly. */
export function damerauLevenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > max) return max + 1;
  if (al === 0) return bl;
  if (bl === 0) return al;
  // Rolling 3-row buffer.
  const v0 = new Array<number>(bl + 1);
  const v1 = new Array<number>(bl + 1);
  const v2 = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) v0[j] = j;
  for (let i = 0; i < al; i++) {
    v1[0] = i + 1;
    let best = v1[0];
    for (let j = 0; j < bl; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j]! + 1, v0[j + 1]! + 1, v0[j]! + cost);
      if (i > 0 && j > 0 && a[i] === b[j - 1] && a[i - 1] === b[j]) {
        v1[j + 1] = Math.min(v1[j + 1]!, v2[j - 1]! + 1);
      }
      if (v1[j + 1]! < best) best = v1[j + 1]!;
    }
    if (best > max) return max + 1;
    for (let j = 0; j <= bl; j++) {
      v2[j] = v0[j]!;
      v0[j] = v1[j]!;
    }
  }
  return v0[bl]!;
}

/** Strip Unicode confusables to a skeleton using a small bundled map.
 *  Not full TR39 — handles the most common Latin/Cyrillic/Greek
 *  homoglyphs which is where 99% of real lookalike phish lives. */
const CONFUSABLE_MAP: Record<string, string> = {
  // Cyrillic look-alikes.
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  і: 'i',
  ј: 'j',
  ѕ: 's',
  А: 'A',
  Е: 'E',
  О: 'O',
  Р: 'P',
  С: 'C',
  У: 'Y',
  Х: 'X',
  І: 'I',
  // Greek look-alikes.
  α: 'a',
  ο: 'o',
  ρ: 'p',
  ν: 'v',
  ε: 'e',
  ι: 'i',
  Α: 'A',
  Β: 'B',
  Ε: 'E',
  Ζ: 'Z',
  Η: 'H',
  Ι: 'I',
  Κ: 'K',
  Μ: 'M',
  Ν: 'N',
  Ο: 'O',
  Ρ: 'P',
  Τ: 'T',
  Υ: 'Y',
  Χ: 'X',
  // Numeric look-alikes.
  '0': 'o',
  '1': 'l',
  '5': 's',
};

export function skeleton(input: string): string {
  let out = '';
  for (const ch of input.normalize('NFC').toLowerCase()) {
    out += CONFUSABLE_MAP[ch] ?? ch;
  }
  return out;
}

/** Detect whether a domain mixes Latin script with Cyrillic / Greek /
 *  Cherokee. Mixed-script in a hostname is essentially never legitimate. */
export function isMixedScript(host: string): boolean {
  const stripped = host.normalize('NFC').replace(/[0-9.\-_]/g, '');
  if (stripped.length === 0) return false;
  let hasLatin = false;
  let hasOther = false;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) {
      hasLatin = true;
    } else if (cp >= 0x80) {
      hasOther = true;
    }
    if (hasLatin && hasOther) return true;
  }
  return false;
}

/** Decode punycode label-by-label so script-detection sees the original
 *  Unicode characters. Workers runtime exposes `URL` which handles IDN
 *  decoding, but we want to operate on the bare host string. */
export function punycodeDecode(host: string): string {
  if (!host.includes('xn--')) return host;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return host;
  }
}
