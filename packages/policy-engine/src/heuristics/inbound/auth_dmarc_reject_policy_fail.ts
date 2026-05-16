import type { Heuristic } from '../../types.js';

export const authDmarcRejectPolicyFail: Heuristic = (input) => {
  if (input.auth.dmarc !== 'fail') return null;
  if (input.auth.dmarc_policy !== 'reject') return null;
  return {
    reason_code: 'auth_dmarc_reject_policy_fail',
    score: -8,
    evidence: 'DMARC fail and From-domain published p=reject',
  };
};
