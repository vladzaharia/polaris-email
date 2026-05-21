import { normalizeAddress } from '@polaris-mail/suppressions';
import type { Heuristic } from '../../types.js';

interface Row {
  cnt: number;
}

const MONEY_LEXICON: ReadonlyArray<RegExp> = [
  /\bwire\s+transfer\b/i,
  /\bgift\s+cards?\b/i,
  /\bcrypto(currency)?\b/i,
  /\bbitcoin\b/i,
  /\binvoice\b/i,
  /\bpayment\s+(due|info|details)\b/i,
  /\bquick\s+favor\b/i,
  /\bare\s+you\s+(at|in)\s+(your|the)\s+(desk|office)\b/i,
  /\boverdue\b/i,
  /\bremit(tance)?\b/i,
];

// Composite: no prior correspondence with this sender AND money-action
// lexical signal. The combination is a strong BEC indicator.
export const firstContactFinancialIntent: Heuristic = async (input) => {
  if (!input.receiver.mailbox_id) return null;
  const from = normalizeAddress(input.message.headers['from']);
  if (!from) return null;

  const text = `${input.message.headers['subject'] ?? ''}\n${input.message.body_preview}`;
  const hits = MONEY_LEXICON.filter((p) => p.test(text));
  if (hits.length === 0) return null;

  // Have we received from this sender before on this mailbox? Use the
  // existing (mailbox_id, from_addr) index on messages.
  const prior = await input.env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM messages
        WHERE mailbox_id=?
          AND direction='in'
          AND header_message_id != ''
          AND from_addr=?
        LIMIT 1`,
  )
    .bind(input.receiver.mailbox_id, from.normalized)
    .first<Row>();
  if (prior && prior.cnt > 0) return null;

  return {
    reason_code: 'first_contact_financial_intent',
    score: -3,
    evidence: `First contact from ${from.normalized} on mailbox ${input.receiver.mailbox_id} with money-action lexicon: ${hits.map((p) => p.source).join(', ')}`,
  };
};
