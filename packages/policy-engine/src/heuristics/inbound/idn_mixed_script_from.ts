import { isMixedScript, parseAddress, punycodeDecode } from '../helpers.js';
import type { Heuristic } from '../../types.js';

// Mixed-script (e.g. Latin + Cyrillic) in a hostname is essentially never
// legitimate — common homograph attack vector.
export const idnMixedScriptFrom: Heuristic = (input) => {
  const from = parseAddress(input.message.headers['from']);
  if (!from.domain) return null;
  const decoded = punycodeDecode(from.domain);
  if (!isMixedScript(decoded)) return null;
  return {
    reason_code: 'idn_mixed_script_from',
    score: -5,
    evidence: `From domain ${from.domain} (decoded: ${decoded}) mixes scripts`,
  };
};
