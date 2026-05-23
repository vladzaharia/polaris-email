// cred-hash — uniform hash + verify across the five mailbox-credential
// types, dispatching on either the credential type (at issue time) or
// the stored hash-string prefix (at verify time).
//
// Algorithm split, locked at plan time:
//   * imap / smtp  — bcrypt (cost 12) so the Go mail-bridge can
//                    `bcrypt.CompareHashAndPassword` against the row
//                    without a Workers round-trip.
//   * rest / mcp /  — PBKDF2-SHA256 (100k iters, PHC string) so the
//     cli            Workers verifier reuses the existing api_keys
//                    hashing helper. Constant-time verify lives in
//                    services/api/src/hashing.ts:verifyPbkdf2.
//
// At verify time we never trust the caller-supplied type — we dispatch
// on the hash-string prefix so a row's auth algorithm is unforgeable
// from outside the DB:
//   * `$2a$` / `$2b$` / `$2y$` → bcrypt
//   * `$pbkdf2-sha256$…`       → PBKDF2

import bcrypt from 'bcryptjs';
import { hashSecret, verifyPbkdf2 } from '../hashing.js';
import type { Env } from '../env.js';

export type CredentialType = 'imap' | 'smtp' | 'rest' | 'mcp' | 'cli';

const BCRYPT_COST = 12;

function usesBcrypt(type: CredentialType): boolean {
  return type === 'imap' || type === 'smtp';
}

function looksLikeBcrypt(hash: string): boolean {
  // bcrypt PHC: `$2a$<cost>$…` / `$2b$…` / `$2y$…`. Length is fixed at 60.
  if (hash.length !== 60) return false;
  return hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$');
}

function looksLikePbkdf2(hash: string): boolean {
  return hash.startsWith('$pbkdf2-sha256$');
}

/**
 * Hash a freshly-minted secret for storage. `env.ARGON2_PEPPER` is
 * applied for the PBKDF2 branch; bcrypt does not use the pepper (the
 * bridge has no access to it and we keep the wire format compatible
 * with existing bridge bcrypt-compare code).
 */
export async function hashForType(type: CredentialType, plain: string, env: Env): Promise<string> {
  if (usesBcrypt(type)) return bcrypt.hash(plain, BCRYPT_COST);
  return hashSecret(plain, env.ARGON2_PEPPER);
}

/**
 * Constant-time verify a candidate plaintext against a stored hash.
 * Dispatches on the hash-string prefix so the row controls which algo
 * it was hashed with. Returns `false` for any unrecognised prefix or
 * malformed hash — never throws.
 */
export async function verifyHash(
  storedHash: string,
  candidate: string,
  env: Env,
): Promise<boolean> {
  if (typeof storedHash !== 'string' || storedHash.length === 0) return false;
  if (looksLikeBcrypt(storedHash)) {
    try {
      return await bcrypt.compare(candidate, storedHash);
    } catch {
      return false;
    }
  }
  if (looksLikePbkdf2(storedHash)) {
    return verifyPbkdf2(storedHash, candidate, env.ARGON2_PEPPER);
  }
  return false;
}

/**
 * Expose the bcrypt/PBKDF2 discriminators for callers that need to
 * branch on the algorithm (e.g. the bridge-credential-lookup endpoint
 * returns the hash to the Go bridge for bcrypt rows, but the bridge
 * cannot consume PBKDF2 rows — those are REST tokens, not IMAP/SMTP).
 */
export function hashAlgo(storedHash: string): 'bcrypt' | 'pbkdf2' | 'unknown' {
  if (looksLikeBcrypt(storedHash)) return 'bcrypt';
  if (looksLikePbkdf2(storedHash)) return 'pbkdf2';
  return 'unknown';
}
