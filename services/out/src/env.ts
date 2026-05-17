export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  FANOUT_QUEUE: Queue<FanoutEvent>;
  /** Custom-metrics sink shared with services/api + services/in. */
  ANALYTICS?: AnalyticsEngineDataset;
  /** Index of `send_email`-style bindings, populated dynamically below. */
  [k: string]: unknown;
}

export interface OutboundQueueMessage {
  messageId: string;
  /** Always 'raw' — the queue handler reads canonical MIME bytes from R2. */
  source: 'raw';
  /** R2 key for the canonical MIME bytes. Mirrors messages.r2_key. */
  r2KeyOrInline: string;
  fromDomain: string;
  fromAddress: string;
  /**
   * Envelope recipients (RCPT TO). The CF `send_email` binding's `to` field
   * is the envelope-to (NOT the From/Sender header), so we must thread the
   * actual recipients through the queue. Producer is
   * `services/api/src/routes/messages.ts` (POST /v1/messages JSON path),
   * which builds this from the SendRequest's `to` + `cc` + `bcc`.
   *
   * For backward-compat with already-enqueued messages from older deploys,
   * the consumer falls back to `[fromAddress]` when this is missing.
   */
  envelopeTo?: string[];
  mailboxId: string;
  domainId: string | null;
  mode: 'live' | 'test';
  // NOTE: `retries` was removed in favour of CF Workers Queues' native
  // `m.attempts` counter. Trusting the queue body for retry count let a
  // malicious / replayed enqueue claim retries=999 and skip straight to
  // failed; the platform-provided counter is the source of truth.
}

export interface FanoutEvent {
  event_id: string;
  event:
    | 'message.received'
    | 'message.bounced'
    | 'message.sent'
    | 'message.delivered'
    | 'message.failed'
    // W1 — emitted when suppression enforcement drops one or more
    // recipients (`message.suppressed`) or the entire send (`message.sender_suppressed`).
    | 'message.suppressed'
    | 'message.sender_suppressed';
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
