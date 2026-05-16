import {
  PROTECTED_BRANDS,
  damerauLevenshtein,
  parseAddress,
  punycodeDecode,
  registrableDomain,
} from '../helpers.js';
import type { Heuristic } from '../../types.js';

// Damerau-Levenshtein ≤2 against any protected brand domain.
// Catches `paypa1.com`, `m1crosoft.com`, `g00gle.com`.
export const typosquatLevenshtein2Brand: Heuristic = (input) => {
  const from = parseAddress(input.message.headers['from']);
  if (!from.domain) return null;
  const fromReg = registrableDomain(punycodeDecode(from.domain));
  if (!fromReg) return null;
  for (const entry of PROTECTED_BRANDS) {
    for (const legit of entry.domains) {
      if (fromReg === legit) return null; // Legit.
      const distance = damerauLevenshtein(fromReg, legit, 2);
      if (distance > 0 && distance <= 2) {
        return {
          reason_code: 'typosquat_levenshtein_2_brand',
          score: -5,
          evidence: `From domain ${fromReg} is Damerau-Levenshtein ${distance} from ${legit}`,
        };
      }
    }
  }
  return null;
};
