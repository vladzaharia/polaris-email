// Hand-maintained type mirrors of `openapi/polaris-email.yaml`.
//
// Despite the `generated/` path, these types are hand-written and kept in
// sync with the OpenAPI spec manually. The `packages/sdk-codegen/` package
// that originally owned this file was deleted in Phase M (commit 71f6e41);
// see `docs/sdk.md` for the current contract on adding/changing endpoints.

export type Ulid = string;

export type KeyScope =
  | 'send'
  | 'messages:read'
  | 'imap_bridge:read'
  | 'admin:rotate'
  | 'admin:read';

export type MessageDirection = 'in' | 'out';
export type MessageStatus =
  | 'received'
  | 'mime_stored'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'bounced'
  | 'delivered'
  | 'failed';

export interface MessageAttachment {
  filename: string;
  content_type: string;
  size_bytes: number;
  content_base64?: string;
  /**
   * Public, content-addressed URL on the R2 custom domain
   * `r2.mail.plrs.im` (B5). Absolute, no expiry. Fetch directly without HMAC.
   */
  url?: string;
}

export interface MessageAuth {
  spf?: string;
  dkim?: string;
  dmarc?: string;
  remote_ip?: string;
}

export interface Message {
  id: Ulid;
  mailbox_id: Ulid;
  direction: MessageDirection;
  status: MessageStatus;
  from: string;
  /**
   * Bare email address extracted from the From: header (mirrors the
   * `from_addr` column on `messages`). Populated whenever the runtime can
   * resolve it; absent for responses that strip envelope metadata.
   */
  from_addr?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  /**
   * Public, content-addressed URL for the raw RFC822 body on the R2 custom
   * domain `r2.mail.plrs.im` (B5). Absolute, no expiry.
   */
  body_url?: string;
  headers?: Record<string, string>;
  attachments: MessageAttachment[];
  header_message_id?: string;
  thread_id?: string;
  auth?: MessageAuth;
  body_bytes?: number;
  attachments_total_bytes?: number;
  received_at_bridge?: string;
  received_at_api?: string;
  queued_at?: string;
  sending_at?: string;
  sent_at?: string;
  delivered_at?: string;
  failed_at?: string;
  bounce_metadata?: unknown;
  last_error?: string;
  created_at: string;
  /**
   * IMAP / bridge per-mailbox state. Populated when the response is rendered
   * for a mailbox-scoped caller (POST /v1/messages/get, PATCH
   * /v1/messages/:id, the mail-bridge mirror bootstrap).
   */
  flags?: string[];
  read_at?: string | null;
  change_id?: number;
}

export interface SendRequestAttachment {
  filename: string;
  content_type: string;
  content_base64: string;
}

export interface SendRequest {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: SendRequestAttachment[];
  reply_to?: string;
  idempotency_key?: string;
}

export interface SendResponse {
  message_id: Ulid;
  status: string;
  fresh: boolean;
}

export interface MessageList {
  data: Message[];
  next_offset: number | null;
}

export type WebhookEventType =
  | 'message.received'
  | 'message.sent'
  | 'message.delivered'
  | 'message.bounced'
  | 'message.failed';

export interface WebhookEnvelope {
  event_id: Ulid;
  event: WebhookEventType;
  occurred_at: string;
  message: Message;
}

export interface Mailbox {
  id: Ulid;
  name: string;
  description?: string | null;
  default_sender_id?: Ulid | null;
  created_at: string;
  updated_at: string;
  disabled_at?: string | null;
}

export interface MailboxSender {
  id: Ulid;
  mailbox_id: Ulid;
  domain_id: Ulid;
  address: string;
  local_part?: string | null;
  display_name?: string | null;
  default_for_mailbox: 0 | 1;
  created_at: string;
  disabled_at?: string | null;
}

export interface MailboxReceiver {
  id: Ulid;
  mailbox_id: Ulid;
  domain_id: Ulid;
  priority: number;
  address_pattern: string;
  action: 'webhook' | 'forward' | 'drop';
  webhook_sub_id?: Ulid | null;
  forward_to?: string | null;
  enabled: 0 | 1;
  created_at: string;
  disabled_at?: string | null;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    request_id: string;
  };
}
