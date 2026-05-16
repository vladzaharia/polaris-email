import { parseAddress, registrableDomain } from '../helpers.js';
import type { Heuristic } from '../../types.js';

const MID_RE = /^<([^@>]+)@([^>]+)>$/;

export const headerMessageIdSane: Heuristic = (input) => {
  const mid = input.message.headers['message-id'];
  if (!mid) return null;
  const m = mid.trim().match(MID_RE);
  if (!m) return null;
  const rhs = (m[2] ?? '').toLowerCase();
  const fromDomain = registrableDomain(
    parseAddress(input.message.headers['from']).domain ?? undefined,
  );
  const ridReg = registrableDomain(rhs);
  if (!fromDomain || !ridReg || fromDomain !== ridReg) return null;
  return {
    reason_code: 'header_message_id_sane',
    score: 1,
    evidence: `Message-ID RHS ${rhs} aligns with From domain ${fromDomain}`,
  };
};
