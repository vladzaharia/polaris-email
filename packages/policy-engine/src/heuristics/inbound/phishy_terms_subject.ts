import type { Heuristic } from '../../types.js';

// A small Aho-Corasick-ish set of patterns commonly seen in phishing /
// credential-harvest subjects. Conservative — only fires on case-insensitive
// match of well-known bait phrases.
const PATTERNS: ReadonlyArray<RegExp> = [
  /\burgent\b/i,
  /\bverify\s+your\s+account\b/i,
  /\baccount\s+suspended\b/i,
  /\bpayroll\s+update\b/i,
  /\bunusual\s+sign[- ]?in\b/i,
  /\bpassword\s+(reset|expired)\b/i,
  /\baction\s+required\b/i,
  /\bclick\s+here\s+to\s+(verify|confirm)\b/i,
  /\binvoice\s+overdue\b/i,
  /\bwire\s+transfer\b/i,
];

export const phishyTermsSubject: Heuristic = (input) => {
  const subject = input.message.headers['subject'] ?? '';
  const hits = PATTERNS.filter((p) => p.test(subject));
  if (hits.length === 0) return null;
  return {
    reason_code: 'phishy_terms_subject',
    score: -3,
    evidence: `Subject matches ${hits.length} phishy pattern(s): ${hits.map((p) => p.source).join(', ')}`,
  };
};
