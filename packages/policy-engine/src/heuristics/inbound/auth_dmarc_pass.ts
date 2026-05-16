import type { Heuristic } from '../../types.js';

export const authDmarcPass: Heuristic = (input) => {
  if (input.auth.dmarc !== 'pass') return null;
  return {
    reason_code: 'auth_dmarc_pass',
    score: 3,
    evidence: 'Authentication-Results reports DMARC=pass',
  };
};
