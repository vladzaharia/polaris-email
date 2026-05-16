import { registrableDomain } from '../helpers.js';
import type { Heuristic } from '../../types.js';

// HTML anchor where the visible text presents a different registrable
// domain than the href target. Classical phishing pattern.
const ANCHOR_RE = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const URL_IN_TEXT = /https?:\/\/([^\s<"']+)/i;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export const urlAnchorMismatch: Heuristic = (input) => {
  const body = input.message.body_preview;
  if (!body || !body.includes('<a')) return null;
  const mismatches: string[] = [];
  for (const match of body.matchAll(ANCHOR_RE)) {
    const hrefHost = hostOf(match[1] ?? '');
    if (!hrefHost) continue;
    const textUrlMatch = URL_IN_TEXT.exec((match[2] ?? '').trim());
    if (!textUrlMatch) continue;
    const textHost = hostOf(`http://${textUrlMatch[1]}`);
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
    score: -5,
    evidence: `Anchor href != visible text domain: ${mismatches.join('; ')}`,
  };
};
