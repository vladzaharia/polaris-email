import { describe, expect, it } from 'vitest';
import { formatBearer, parseBearer, prefixForType } from '../src/lib/parse-bearer.js';

const VALID_KID = '01J5K2VR9XYZ0ABCDEFG123456'; // 26 chars Crockford base32
const VALID_SECRET = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJKMNPQRSTVWX'; // 52 chars

describe('parseBearer', () => {
  it('parses valid REST tokens', () => {
    const parsed = parseBearer(`pmtk_${VALID_KID}.${VALID_SECRET}`);
    expect(parsed).toEqual({
      type: 'rest',
      prefix: 'pmtk_',
      kid: VALID_KID,
      secret: VALID_SECRET,
    });
  });

  it('parses valid MCP tokens', () => {
    const parsed = parseBearer(`pmmcp_${VALID_KID}.${VALID_SECRET}`);
    expect(parsed?.type).toBe('mcp');
    expect(parsed?.prefix).toBe('pmmcp_');
  });

  it('parses valid CLI tokens', () => {
    const parsed = parseBearer(`pmcli_${VALID_KID}.${VALID_SECRET}`);
    expect(parsed?.type).toBe('cli');
    expect(parsed?.prefix).toBe('pmcli_');
  });

  it('trims surrounding whitespace', () => {
    const parsed = parseBearer(`  pmtk_${VALID_KID}.${VALID_SECRET}\n`);
    expect(parsed?.kid).toBe(VALID_KID);
  });

  it('rejects empty / null / undefined', () => {
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer('')).toBeNull();
    expect(parseBearer('   ')).toBeNull();
  });

  it('rejects unknown prefixes', () => {
    expect(parseBearer(`polaris_${VALID_KID}.${VALID_SECRET}`)).toBeNull(); // operator scheme
    expect(parseBearer(`pk_live_${VALID_KID}.${VALID_SECRET}`)).toBeNull(); // legacy api_key
    expect(parseBearer(`pmimap_${VALID_KID}.${VALID_SECRET}`)).toBeNull(); // IMAP — uses USER+PASS, not bearer
    expect(parseBearer(`pmsmtp_${VALID_KID}.${VALID_SECRET}`)).toBeNull();
    expect(parseBearer(`${VALID_KID}.${VALID_SECRET}`)).toBeNull(); // no prefix
  });

  it('rejects malformed kid/secret structure', () => {
    expect(parseBearer(`pmtk_${VALID_KID}${VALID_SECRET}`)).toBeNull(); // missing dot
    expect(parseBearer(`pmtk_.${VALID_SECRET}`)).toBeNull(); // empty kid (kid length 0)
    expect(parseBearer(`pmtk_${VALID_KID}.`)).toBeNull(); // empty secret
  });

  it('rejects extra dots — the secret must be pure Crockford base32', () => {
    // Slicing on the FIRST dot means anything after it becomes the
    // candidate secret. A dot in the secret fails the Crockford charset
    // check, so trailing-dot tokens are rejected.
    expect(parseBearer(`pmtk_${VALID_KID}.${VALID_SECRET}.extra`)).toBeNull();
  });

  it('rejects wrong kid length', () => {
    expect(parseBearer(`pmtk_${VALID_KID.slice(0, 25)}.${VALID_SECRET}`)).toBeNull(); // 25 chars
    expect(parseBearer(`pmtk_${VALID_KID}X.${VALID_SECRET}`)).toBeNull(); // 27 chars
  });

  it('rejects out-of-range secret length', () => {
    expect(parseBearer(`pmtk_${VALID_KID}.${'A'.repeat(31)}`)).toBeNull(); // too short
    expect(parseBearer(`pmtk_${VALID_KID}.${'A'.repeat(65)}`)).toBeNull(); // too long
  });

  it('rejects non-Crockford characters', () => {
    // Crockford base32 excludes I, L, O, U
    expect(parseBearer(`pmtk_${'I'.repeat(26)}.${VALID_SECRET}`)).toBeNull();
    expect(parseBearer(`pmtk_${VALID_KID}.${'L'.repeat(52)}`)).toBeNull();
    expect(parseBearer(`pmtk_${VALID_KID}.${'O'.repeat(52)}`)).toBeNull();
    expect(parseBearer(`pmtk_${VALID_KID}.${'U'.repeat(52)}`)).toBeNull();
    // lowercase is also rejected (Crockford normalises to upper)
    expect(parseBearer(`pmtk_${VALID_KID.toLowerCase()}.${VALID_SECRET}`)).toBeNull();
  });
});

describe('prefixForType', () => {
  it('returns the literal prefix per type', () => {
    expect(prefixForType('rest')).toBe('pmtk_');
    expect(prefixForType('mcp')).toBe('pmmcp_');
    expect(prefixForType('cli')).toBe('pmcli_');
  });
});

describe('formatBearer', () => {
  it('is the inverse of parseBearer', () => {
    const bearer = formatBearer('rest', VALID_KID, VALID_SECRET);
    expect(bearer).toBe(`pmtk_${VALID_KID}.${VALID_SECRET}`);
    expect(parseBearer(bearer)).toEqual({
      type: 'rest',
      prefix: 'pmtk_',
      kid: VALID_KID,
      secret: VALID_SECRET,
    });
  });

  it('round-trips all three types', () => {
    for (const type of ['rest', 'mcp', 'cli'] as const) {
      const bearer = formatBearer(type, VALID_KID, VALID_SECRET);
      const parsed = parseBearer(bearer);
      expect(parsed?.type).toBe(type);
      expect(parsed?.kid).toBe(VALID_KID);
      expect(parsed?.secret).toBe(VALID_SECRET);
    }
  });
});
