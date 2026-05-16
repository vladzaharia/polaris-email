import { registrableDomain } from '../helpers.js';
import type { Heuristic } from '../../types.js';

const ANCHOR_RE = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const URL_IN_TEXT = /https?:\/\/([^\s<"']+)/i;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Flags potentially-malicious agent output: LLM-generated email body where
// the displayed link doesn't match the actual destination.
export const urlAnchorMismatch: Heuristic = (input) => {
  const body = input.message.body_preview;
  if (!body || !body.includes('<a')) return null;
  const mismatches: string[] = [];
  for (const match of body.matchAll(ANCHOR_RE)) {
    const hrefHost = hostOf(match[1] ?? '');
    if (!hrefHost) continue;
    const textHit = (match[2] ?? '').trim().match(URL_IN_TEXT);
    if (!textHit) continue;
    const textHost = hostOf(`http://${textHit[1]}`);
    if (!textHost) continue;
    const hrefReg = registrableDomain(hrefHost);
    const textReg = registrableDomain(textHost);
    if (hrefReg && textReg && hrefReg !== textReg) {
      mismatches.push(`${textHost}->${hrefHost}`);
      if (mismatches.length >= 3) break;
    }
  }
  if (mismatches.length === 0) return null;
  return {
    reason_code: 'url_anchor_mismatch',
    score: -7,
    evidence: `Outbound anchor href != visible text domain: ${mismatches.join('; ')}`,
  };
};
