import { parseAddress } from '../helpers.js';
import type { Heuristic } from '../../types.js';

const ROLE_LOCAL_PARTS: ReadonlySet<string> = new Set([
  'postmaster',
  'abuse',
  'security',
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'mailer-daemon',
  'admin',
  'root',
  'hostmaster',
]);

// Cold outreach to role accounts is almost always a mis-target (e.g. agent
// sending a sales pitch to security@). Mild negative weight to nudge
// borderline messages to hold for admin review.
export const recipientRoleAccount: Heuristic = (input) => {
  const to = parseAddress(input.receiver.address);
  if (!to.local) return null;
  if (!ROLE_LOCAL_PARTS.has(to.local)) return null;
  return {
    reason_code: 'recipient_role_account',
    score: -3,
    evidence: `Recipient ${input.receiver.address} is a role account (${to.local}@) — likely mis-target`,
  };
};
