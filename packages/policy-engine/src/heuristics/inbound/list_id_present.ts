import type { Heuristic } from '../../types.js';

export const listIdPresent: Heuristic = (input) => {
  if (!input.message.headers['list-id']) return null;
  return {
    reason_code: 'list_id_present',
    score: 2,
    evidence: 'List-ID header present (legitimate mailing list)',
  };
};
