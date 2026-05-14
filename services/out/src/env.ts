export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  FANOUT_QUEUE: Queue<FanoutEvent>;
  /** Index of `send_email`-style bindings, populated dynamically below. */
  [k: string]: unknown;
}

export interface OutboundQueueMessage {
  messageId: string;
  /** Always 'raw' post Phase C — legacy `source='json'` is gone. */
  source: 'raw';
  /** R2 key for the canonical MIME bytes. Mirrors messages.r2_key. */
  r2KeyOrInline: string;
  fromDomain: string;
  fromAddress: string;
  tenantId: string;
  domainId: string | null;
  mode: 'live' | 'test';
  retries: number;
}

export interface FanoutEvent {
  event_id: string;
  event:
    | 'message.received'
    | 'message.bounced'
    | 'message.sent'
    | 'message.delivered'
    | 'message.failed';
  message_id: string;
  mailbox_id: string | null;
  domain_id: string | null;
  created_at: number;
  data?: Record<string, unknown>;
}

/** Cloudflare's send_email binding type (mirror of @cloudflare/workers-types). */
export interface SendEmailBinding {
  send(message: {
    from: string;
    to: string | string[];
    raw?: ArrayBuffer | Uint8Array | string;
    cc?: string | string[];
    bcc?: string | string[];
    replyTo?: string;
    subject?: string;
    html?: string;
    text?: string;
    headers?: Record<string, string>;
    attachments?: { filename: string; contentType: string; content: ArrayBuffer | string }[];
  }): Promise<{ delivered: string[]; permanent_bounces: string[]; queued: string[] }>;
}
