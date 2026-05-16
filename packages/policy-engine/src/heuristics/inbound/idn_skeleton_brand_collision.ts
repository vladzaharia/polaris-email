import {
  PROTECTED_BRANDS,
  parseAddress,
  punycodeDecode,
  registrableDomain,
  skeleton,
} from '../helpers.js';
import type { Heuristic } from '../../types.js';

// Unicode-skeleton lookalike of a protected brand domain. Catches
// `paypaI.com` (capital-I), Cyrillic-a impersonations, etc.
export const idnSkeletonBrandCollision: Heuristic = (input) => {
  const from = parseAddress(input.message.headers['from']);
  if (!from.domain) return null;
  const decoded = punycodeDecode(from.domain);
  const fromReg = registrableDomain(decoded);
  if (!fromReg) return null;
  const fromSkeleton = skeleton(fromReg);
  for (const entry of PROTECTED_BRANDS) {
    for (const legit of entry.domains) {
      if (fromReg === legit) return null; // Legit brand-owned domain.
      if (skeleton(legit) === fromSkeleton && legit !== fromReg) {
        return {
          reason_code: 'idn_skeleton_brand_collision',
          score: -7,
          evidence: `From domain ${fromReg} skeleton matches ${legit}`,
        };
      }
    }
  }
  return null;
};
