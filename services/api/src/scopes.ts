// Sender-scope matcher: exact / glob / regex with ReDoS guard.
import type { z } from 'zod';
import { SenderScope } from '@polaris-email/schema';

export type SenderScopeT = z.infer<typeof SenderScope>;

/** Defensive cap on regex length + a CPU-budget hint via runtime length check. */
const MAX_REGEX_LEN = 256;

export function matchesSenderScope(
  address: string,
  scopes: readonly SenderScopeT[],
): boolean {
  const norm = address.trim().toLowerCase();
  for (const s of scopes) {
    if (s.kind === 'exact') {
      if (norm === s.pattern.toLowerCase()) return true;
    } else if (s.kind === 'glob') {
      if (globMatch(norm, s.pattern.toLowerCase())) return true;
    } else {
      if (s.pattern.length > MAX_REGEX_LEN) continue;
      try {
        const re = new RegExp('^(?:' + s.pattern + ')$');
        if (re.test(norm)) return true;
      } catch {
        // ignored: malformed regex never matches
      }
    }
  }
  return false;
}

/**
 * Glob: `*` matches one or more chars within local-part OR host (no spanning `@`).
 * Examples: `*@example.com`, `support-*@example.com`, `*@*.example.com`.
 * Rejects unanchored patterns at parse time (schema does this).
 */
export function globMatch(addr: string, pattern: string): boolean {
  if (!pattern.includes('@')) return false;
  const [pl, ph] = pattern.split('@', 2);
  const [al, ah] = addr.split('@', 2);
  if (al == null || ah == null) return false;
  return globPart(al, pl ?? '') && globPart(ah, ph ?? '');
}

function globPart(s: string, pat: string): boolean {
  // No spanning `@` (each side handled separately). Translate `*` to `.+`, escape the rest.
  const re = '^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.+') + '$';
  try {
    return new RegExp(re).test(s);
  } catch {
    return false;
  }
}
