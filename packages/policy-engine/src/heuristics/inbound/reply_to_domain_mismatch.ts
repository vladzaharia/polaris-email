import { parseAddress, registrableDomain } from '../helpers.js';
import type { Heuristic } from '../../types.js';

// Classic BEC pivot: Reply-To points to a different registrable domain than
// From. Some legit cases exist (mailing-list servers), but in combination
// with other signals this is a strong indicator.
export const replyToDomainMismatch: Heuristic = (input) => {
  const replyToHeader = input.message.headers['reply-to'];
  if (!replyToHeader) return null;
  const from = parseAddress(input.message.headers['from']);
  const replyTo = parseAddress(replyToHeader);
  if (!from.domain || !replyTo.domain) return null;
  const fromReg = registrableDomain(from.domain);
  const replyReg = registrableDomain(replyTo.domain);
  if (!fromReg || !replyReg || fromReg === replyReg) return null;
  return {
    reason_code: 'reply_to_domain_mismatch',
    score: -4,
    evidence: `Reply-To ${replyReg} differs from From ${fromReg}`,
  };
};
