import type { Heuristic } from '../../types.js';

export const authDmarcFail: Heuristic = (input) => {
  if (input.auth.dmarc !== 'fail') return null;
  return {
    reason_code: 'auth_dmarc_fail',
    score: -5,
    evidence: 'Authentication-Results reports DMARC=fail',
  };
};
