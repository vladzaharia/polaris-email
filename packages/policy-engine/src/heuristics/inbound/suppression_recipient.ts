import { normalizeAddress } from '@polaris-mail/suppressions';
import type { Heuristic } from '../../types.js';

interface Row {
  id: string;
}

// On inbound we read the suppressions table to penalise mail TO a recipient
// where the SENDER address is in the entity_type='sender' list — i.e. someone
// trying to reach an inbox we've globally banned the sender from. Decisive.
export const suppressionRecipient: Heuristic = async (input) => {
  const from = normalizeAddress(input.message.headers['from']);
  if (!from) return null;
  const hit = await input.env.DB.prepare(
    `SELECT id FROM suppressions
        WHERE entity_type='sender'
          AND address_normalized=?
          AND (expires_at IS NULL OR expires_at > ?)
          AND disabled_at IS NULL
        LIMIT 1`,
  )
    .bind(from.normalized, new Date().toISOString())
    .first<Row>();
  if (!hit) return null;
  return {
    reason_code: 'suppression_recipient',
    score: -20,
    evidence: `Sender ${from.normalized} matches active sender suppression ${hit.id}`,
  };
};
