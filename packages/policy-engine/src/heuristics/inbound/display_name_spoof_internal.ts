import { parseAddress } from '../helpers.js';
import type { Heuristic } from '../../types.js';

interface PrincipalRow {
  display_name: string;
}

// SPARSE / BEC pattern: From: "Alice CEO" <attacker@gmail.com> where
// "Alice CEO" is the display-name of an internal principal but the From
// domain is not one of ours.
export const displayNameSpoofInternal: Heuristic = async (input) => {
  const from = parseAddress(input.message.headers['from']);
  if (!from.display_name || !from.domain) return null;
  if (input.sender.domain_id) return null; // From is one of our domains — not spoof.
  const display = from.display_name.trim();
  if (display.length < 3) return null;
  const hit = await input.env.DB.prepare(
    `SELECT display_name FROM principals
        WHERE LOWER(display_name) = LOWER(?)
        LIMIT 1`,
  )
    .bind(display)
    .first<PrincipalRow>();
  if (!hit) return null;
  return {
    reason_code: 'display_name_spoof_internal',
    score: -7,
    evidence: `Display-name "${display}" matches an internal principal but From domain ${from.domain} is external`,
  };
};
