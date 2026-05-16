// Shared `messages` D1 row shape + `rowMeta()` projection used by every
// route handler that surfaces a `Message` to the wire (`routes/messages.ts`,
// `routes/messages-state.ts`, the fanout envelope builder).
//
// The two route files used to maintain identical local copies; consolidating
// here keeps the projection in lockstep with the `messages` table schema —
// any new column the wire response cares about is added in exactly one
// place.

import type { MessageRowMeta } from '@polaris-email/mime';

export type MessageRow = {
  id: string;
  mailbox_id: string;
  principal_id: string | null;
  direction: 'in' | 'out';
  status: string;
  from_addr: string;
  to_addrs: string | null;
  subject: string | null;
  r2_key: string;
  body_bytes: number | null;
  attachments_total_bytes: number | null;
  thread_id: string | null;
  header_message_id: string | null;
  auth_spf: string | null;
  auth_dkim: string | null;
  auth_dmarc: string | null;
  auth_remote_ip: string | null;
  received_at_bridge: string | null;
  received_at_api: string | null;
  queued_at: string | null;
  sending_at: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  bounce_metadata: string | null;
  last_error: string | null;
  created_at: string;
};

export function rowMeta(row: MessageRow): MessageRowMeta {
  return {
    id: row.id,
    mailbox_id: row.mailbox_id,
    direction: row.direction,
    status: row.status,
    thread_id: row.thread_id,
    header_message_id: row.header_message_id,
    auth_spf: row.auth_spf,
    auth_dkim: row.auth_dkim,
    auth_dmarc: row.auth_dmarc,
    auth_remote_ip: row.auth_remote_ip,
    body_bytes: row.body_bytes,
    attachments_total_bytes: row.attachments_total_bytes,
    received_at_bridge: row.received_at_bridge,
    received_at_api: row.received_at_api,
    queued_at: row.queued_at,
    sending_at: row.sending_at,
    sent_at: row.sent_at,
    delivered_at: row.delivered_at,
    failed_at: row.failed_at,
    bounce_metadata: row.bounce_metadata,
    last_error: row.last_error,
    created_at: row.created_at,
  };
}
