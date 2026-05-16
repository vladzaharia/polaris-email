import type { Heuristic } from '../../types.js';

const FUTURE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const headerInvalidDate: Heuristic = (input) => {
  const date = input.message.headers['date'];
  if (!date) return null;
  const parsed = Date.parse(date);
  if (Number.isNaN(parsed)) {
    return {
      reason_code: 'header_invalid_date',
      score: -2,
      evidence: `Date: "${date}" unparseable`,
    };
  }
  if (parsed - Date.now() > FUTURE_WINDOW_MS) {
    return {
      reason_code: 'header_invalid_date',
      score: -2,
      evidence: `Date: "${date}" is more than 24h in the future`,
    };
  }
  return null;
};
