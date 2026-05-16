import type { Heuristic } from '../../types.js';

interface Row {
  direction: string;
  mailbox_id: string;
}

// Agent stream + in_reply_to points to a message WE originally received
// = legitimate reply chain, not unsolicited outreach. Strong positive
// signal for agent-generated mail.
export const agentSelfReplyChain: Heuristic = async (input) => {
  if (input.stream_type !== 'agent') return null;
  const irt = input.message.in_reply_to_message_id;
  if (!irt) return null;
  const parent = await input.env.DB.prepare(
    `SELECT direction, mailbox_id FROM messages WHERE header_message_id=? LIMIT 1`,
  )
    .bind(irt)
    .first<Row>();
  if (!parent || parent.direction !== 'in') return null;
  if (input.sender.mailbox_id && parent.mailbox_id !== input.sender.mailbox_id) return null;
  return {
    reason_code: 'agent_self_reply_chain',
    score: 3,
    evidence: `Agent reply on a real inbound thread (parent message id ${irt})`,
  };
};
