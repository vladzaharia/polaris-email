import { normalizeAddress } from '@polaris-email/suppressions';
import type { Heuristic } from '../../types.js';

interface Row {
  id: string;
}

// Per-mailbox blocklist a customer/admin manages directly (inbound_sender_blocks).
// Decisive: any hit by itself lands the message in 'block_decisive' band.
export const inboundSenderBlocked: Heuristic = async (input) => {
  if (!input.receiver.mailbox_id) return null;
  const from = normalizeAddress(input.message.headers['from']);
  if (!from) return null;
  const hit = await input.env.DB.prepare(
    `SELECT id FROM inbound_sender_blocks
        WHERE mailbox_id=?
          AND sender_address_normalized=?
        LIMIT 1`,
  )
    .bind(input.receiver.mailbox_id, from.normalized)
    .first<Row>();
  if (!hit) return null;
  return {
    reason_code: 'inbound_sender_blocked',
    score: -20,
    evidence: `Sender ${from.normalized} on mailbox ${input.receiver.mailbox_id} blocklist`,
  };
};
