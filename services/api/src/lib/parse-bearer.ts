// parseBearer — split a mailbox-credential Bearer string into (type, prefix, kid, secret).
//
// Mirror of `ParseBearer` in apps/polaris-cli/internal/credstore/credstore.go:175-197,
// but for the mailbox-credential prefix family rather than operator tokens:
//
//   pmtk_<26-char ULID>.<~52-char Crockford base32 secret>   — REST
//   pmmcp_<26-char ULID>.<~52-char Crockford base32 secret>  — MCP
//   pmcli_<26-char ULID>.<~52-char Crockford base32 secret>  — CLI
//
// IMAP/SMTP credentials are NOT parsed here — they arrive as separate
// USER + PASS, where the USER is just `<prefix><kid>` (no dot, no secret).
// Use a different helper if you need to extract the kid from an
// IMAP/SMTP username.
//
// Returns null on any malformation. We do constant-time work elsewhere
// (the actual secret comparison happens in cred-hash.ts against the
// stored PBKDF2 hash); this parser is just structural so quick rejection
// is fine.

export type BearerType = 'rest' | 'mcp' | 'cli';

export interface ParsedBearer {
  type: BearerType;
  prefix: string;
  kid: string;
  secret: string;
}

const BEARER_PREFIXES: ReadonlyArray<{ prefix: string; type: BearerType }> = [
  { prefix: 'pmtk_', type: 'rest' },
  { prefix: 'pmmcp_', type: 'mcp' },
  { prefix: 'pmcli_', type: 'cli' },
];

// 26-char Crockford ULID (sortable, matches operator scheme).
const KID_LENGTH = 26;
// 256-bit Crockford base32 is exactly 52 chars; allow a small window so
// future tweaks to entropy (e.g. 192-bit -> 39 chars, 320-bit -> 64
// chars) don't need a parser change.
const SECRET_MIN_LENGTH = 32;
const SECRET_MAX_LENGTH = 64;
// Crockford alphabet — same as packages/hmac/src/index.ts:280
// (0-9 plus A-Z minus I, L, O, U).
const CROCKFORD_REGEX = /^[0-9A-HJKMNP-TV-Z]+$/;

export function parseBearer(bearer: string | null | undefined): ParsedBearer | null {
  if (typeof bearer !== 'string') return null;
  const trimmed = bearer.trim();
  if (trimmed.length === 0) return null;
  for (const { prefix, type } of BEARER_PREFIXES) {
    if (!trimmed.startsWith(prefix)) continue;
    const rest = trimmed.slice(prefix.length);
    const dot = rest.indexOf('.');
    if (dot <= 0 || dot === rest.length - 1) return null;
    const kid = rest.slice(0, dot);
    const secret = rest.slice(dot + 1);
    if (kid.length !== KID_LENGTH) return null;
    if (secret.length < SECRET_MIN_LENGTH || secret.length > SECRET_MAX_LENGTH) return null;
    if (!CROCKFORD_REGEX.test(kid)) return null;
    if (!CROCKFORD_REGEX.test(secret)) return null;
    return { type, prefix, kid, secret };
  }
  return null;
}

export function prefixForType(type: BearerType): string {
  for (const p of BEARER_PREFIXES) if (p.type === type) return p.prefix;
  throw new Error(`unknown bearer type: ${type}`);
}

export function formatBearer(type: BearerType, kid: string, secret: string): string {
  return `${prefixForType(type)}${kid}.${secret}`;
}
