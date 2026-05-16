import type { Heuristic } from '../../types.js';

export const mimeHtmlOnlyNoText: Heuristic = (input) => {
  if (!input.message.html_only) return null;
  return {
    reason_code: 'mime_html_only_no_text',
    score: -1,
    evidence: 'HTML body part with no text/plain alternative',
  };
};
