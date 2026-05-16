import type { Heuristic } from '../../types.js';

export const dmarcAlignmentOk: Heuristic = (input) => {
  const state = input.sender.dmarc_promotion_state;
  if (state !== 'quarantine' && state !== 'reject' && state !== 'reject_ready') return null;
  return {
    reason_code: 'dmarc_alignment_ok',
    score: 3,
    evidence: `Sender domain DMARC promotion state=${state} (good standing)`,
  };
};
