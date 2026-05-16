import type { Heuristic } from '../../types.js';

export const streamMarketingNoUnsub: Heuristic = (input) => {
  if (input.stream_type !== 'marketing') return null;
  if (input.message.headers['list-unsubscribe']) return null;
  return {
    reason_code: 'stream_marketing_no_unsub',
    score: -15,
    evidence:
      'stream_type=marketing but List-Unsubscribe absent (Gmail/Yahoo 2026 bulk-sender violation)',
  };
};
