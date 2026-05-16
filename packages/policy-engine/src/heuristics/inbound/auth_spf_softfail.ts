import type { Heuristic } from '../../types.js';

export const authSpfSoftfail: Heuristic = (input) => {
  const spf = input.auth.spf;
  if (spf !== 'softfail' && spf !== 'neutral') return null;
  return {
    reason_code: 'auth_spf_softfail',
    score: -2,
    evidence: `Authentication-Results reports SPF=${spf}`,
  };
};
