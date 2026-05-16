import type { Heuristic } from '../../types.js';

// Outbound sender_abuse_tier weighted heavier than inbound because we're
// the one delivering — a tier-2 sender getting more outbound chances harms
// our domain reputation faster.
export const senderAbuseTier: Heuristic = (input) => {
  const tier = input.sender.abuse_tier;
  if (!tier || tier <= 0) return null;
  return {
    reason_code: 'sender_abuse_tier',
    score: -3 * tier,
    evidence: `Sender W2c abuse tier=${tier}`,
  };
};
