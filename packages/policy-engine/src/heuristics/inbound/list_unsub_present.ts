import type { Heuristic } from '../../types.js';

export const listUnsubPresent: Heuristic = (input) => {
  if (!input.message.headers['list-unsubscribe']) return null;
  return {
    reason_code: 'list_unsub_present',
    score: 2,
    evidence: 'List-Unsubscribe header present (legitimate bulk sender practice)',
  };
};
