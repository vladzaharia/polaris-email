import type { Heuristic } from '../../types.js';

export const authDkimFail: Heuristic = (input) => {
  if (input.auth.dkim?.result !== 'fail') return null;
  return {
    reason_code: 'auth_dkim_fail',
    score: -5,
    evidence: 'Authentication-Results reports DKIM=fail (signature present but invalid)',
  };
};
