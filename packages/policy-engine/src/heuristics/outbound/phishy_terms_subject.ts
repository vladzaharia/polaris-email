import type { Heuristic } from '../../types.js';

const PATTERNS: ReadonlyArray<RegExp> = [
  /\burgent\b/i,
  /\bverify\s+your\s+account\b/i,
  /\baccount\s+suspended\b/i,
  /\bpayroll\s+update\b/i,
  /\bunusual\s+sign[- ]?in\b/i,
  /\bpassword\s+(reset|expired)\b/i,
  /\baction\s+required\b/i,
  /\bclick\s+here\s+to\s+(verify|confirm)\b/i,
];

// Stricter weight than inbound — outbound from us with phishy subjects
// risks deliverability + reputation.
export const phishyTermsSubject: Heuristic = (input) => {
  const subject = input.message.headers['subject'] ?? '';
  const hits = PATTERNS.filter((p) => p.test(subject));
  if (hits.length === 0) return null;
  return {
    reason_code: 'phishy_terms_subject',
    score: -5,
    evidence: `Outbound subject matches ${hits.length} phishy pattern(s)`,
  };
};
