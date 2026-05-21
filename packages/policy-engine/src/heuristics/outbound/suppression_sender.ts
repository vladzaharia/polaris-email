import { normalizeAddress } from '@polaris-mail/suppressions';
import type { Heuristic } from '../../types.js';

interface Row {
  id: string;
}

export const suppressionSender: Heuristic = async (input) => {
  const from = normalizeAddress(input.sender.address);
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
    reason_code: 'suppression_sender',
    score: -20,
    evidence: `Sender ${from.normalized} matches active sender suppression ${hit.id}`,
  };
};
