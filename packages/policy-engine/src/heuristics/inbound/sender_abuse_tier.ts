import type { Heuristic } from '../../types.js';

// Inbound — if the sender is also one of OUR principals (cross-tenant
// send-then-reply case) and W2c has flagged their abuse tier > 0, that
// signal applies inbound too.
export const senderAbuseTier: Heuristic = (input) => {
  const tier = input.sender.abuse_tier;
  if (!tier || tier <= 0) return null;
  return {
    reason_code: 'sender_abuse_tier',
    score: -2 * tier,
    evidence: `Sender W2c abuse tier=${tier}`,
  };
};
