// Cloudflare environment bindings for polaris-email-api.
export interface Env {
  DB: D1Database;

  R2: R2Bucket;
  KV_NONCE: KVNamespace;
  KV_IDEMPOTENCY: KVNamespace;
  KV_RATE_LIMIT: KVNamespace;
  KV_KEY_CACHE: KVNamespace;
  /** Per-principal revocation timestamps; absence = not revoked. See packages/revocation. */
  KV_REVOCATIONS: KVNamespace;

  OUTBOUND_QUEUE: Queue<OutboundQueueMessage>;

  API_BASE_URL: string;

  /**
   * Public host that serves the `polaris-email` R2 bucket. Bodies +
   * attachments are surfaced at `https://${R2_PUBLIC_HOST}/<key>` (B5).
   * Defaults to `r2.mail.plrs.im` in deployed configs.
   */
  R2_PUBLIC_HOST: string;

  /** Max raw body bytes returned inline on GET responses. Larger ⇒ body_url only. */
  INLINE_BODY_BYTES_MAX?: string;
  INLINE_ATTACHMENTS_BYTES_MAX?: string;

  // -- scheduled (cron) handlers, absorbed from services/cron in B1 ----------
  /** R2 key prefix for hourly audit anchors written by the `anchor` cron. */
  ANCHOR_R2_PREFIX?: string;
  /** HMAC signing key (base64) used by the `anchor` cron. */
  ANCHOR_SIGNING_KEY?: string;
  /** Webhook URL hit by `staleness` + `synthetic` cron alerts. */
  ALERT_WEBHOOK?: string;
  /** Synthetic probe upper-bound latency, milliseconds, as a string. */
  MAX_LATENCY_MS?: string;
  /** Grace window (days) for the janitor's expunged_at sweep. */
  BRIDGE_EXPUNGE_GRACE_DAYS?: string;

  // Secrets via `wrangler secret put`:
  POLARIS_SECRET_A?: string;
  POLARIS_SECRET_B?: string;
  ARGON2_PEPPER?: string;
  /** HMAC master pepper for HKDF-derived per-tenant peppers (I13). */
  PEPPER_MASTER?: string;
  /** HMAC key shared with the submission bridge for /v1/bridge/* + /v1/messages (RFC822). */
  BRIDGE_HMAC_KEY?: string;
}

export interface OutboundQueueMessage {
  messageId: string;
  /** Pre-rendered RFC822 stored in R2; outbound is always raw. */
  source: 'raw';
  r2KeyOrInline: string;
  fromDomain: string;
  fromAddress: string;
  mailboxId: string;
  domainId: string | null;
  mode: 'live' | 'test';
  retries: number;
}
