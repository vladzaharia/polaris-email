import { parseAddress, registrableDomain } from '../helpers.js';
import type { Heuristic } from '../../types.js';

export const dkimAlignedAuthor: Heuristic = (input) => {
  const dkim = input.auth.dkim;
  if (dkim?.result !== 'pass') return null;
  const signing = registrableDomain(dkim.signing_domain);
  const from = parseAddress(input.message.headers['from']);
  const author = registrableDomain(from.domain ?? undefined);
  if (!signing || !author || signing !== author) return null;
  return {
    reason_code: 'dkim_aligned_author',
    score: 2,
    evidence: `DKIM d=${signing} aligns with From domain`,
  };
};
