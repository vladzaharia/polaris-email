import { parseAddress } from '../helpers.js';
import type { Heuristic } from '../../types.js';

// To:/Cc: headers don't include the actual envelope RCPT — strong BCC-spray
// indicator. The envelope-to is what was actually delivered; the headers
// claim someone else was the recipient.
export const forgedRecipients: Heuristic = (input) => {
  const envelope = input.receiver.address.toLowerCase();
  if (!envelope) return null;
  const claimed = [input.message.headers['to'], input.message.headers['cc']]
    .filter((v): v is string => Boolean(v))
    .flatMap((v) => v.split(','))
    .map((v) => parseAddress(v).address)
    .filter((v): v is string => Boolean(v));
  if (claimed.length === 0) return null;
  if (claimed.some((addr) => addr === envelope)) return null;
  return {
    reason_code: 'forged_recipients',
    score: -3,
    evidence: `Envelope RCPT ${envelope} not in To:/Cc: (claimed: ${claimed.slice(0, 3).join(', ')})`,
  };
};
