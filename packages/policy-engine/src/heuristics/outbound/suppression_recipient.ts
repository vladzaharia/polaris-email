import { normalizeAddress } from '@polaris-email/suppressions';
import type { Heuristic } from '../../types.js';

interface Row {
  id: string;
}

// Outbound: recipient is on the entity_type='recipient' suppression list.
// Already enforced by W1 — the engine surfaces it as a reason for symmetry
// and because the policy decision should be visible in policy_decisions.
export const suppressionRecipient: Heuristic = async (input) => {
  const to = normalizeAddress(input.receiver.address);
  if (!to) return null;
  const hit = await input.env.DB.prepare(
    `SELECT id FROM suppressions
        WHERE entity_type='recipient'
          AND address_normalized=?
          AND (expires_at IS NULL OR expires_at > ?)
          AND disabled_at IS NULL
        LIMIT 1`,
  )
    .bind(to.normalized, new Date().toISOString())
    .first<Row>();
  if (!hit) return null;
  return {
    reason_code: 'suppression_recipient',
    score: -20,
    evidence: `Recipient ${to.normalized} matches active recipient suppression ${hit.id}`,
  };
};
