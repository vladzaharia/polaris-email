// Cloudflare environment bindings for polaris-email-api.
export interface Env {
  DB: D1Database;

  R2: R2Bucket;
  KV_NONCE: KVNamespace;
  KV_IDEMPOTENCY: KVNamespace;
  KV_RATE_LIMIT: KVNamespace;
  KV_KEY_CACHE: KVNamespace;

  OUTBOUND_QUEUE: Queue<OutboundQueueMessage>;

  /** Per-principal revocation Durable Object. Synchronous truth for revocation state. */
  REVOCATION_DO: DurableObjectNamespace;

  VERIFY_ALGORITHMS: string;
  API_BASE_URL: string;

  /** Max raw body bytes returned inline on GET responses. Larger ⇒ signed-url path. */
  INLINE_BODY_BYTES_MAX?: string;
  INLINE_ATTACHMENTS_BYTES_MAX?: string;

  // Secrets via `wrangler secret put`:
  POLARIS_SECRET_A?: string;
  POLARIS_SECRET_B?: string;
  ARGON2_PEPPER?: string;
  /** HMAC master pepper for HKDF-derived per-tenant peppers (I13). */
  PEPPER_MASTER?: string;
  /** HMAC key shared with the submission daemon for /v1/daemon/* + /v1/messages (RFC822). */
  DAEMON_HMAC_KEY?: string;
}

export interface OutboundQueueMessage {
  messageId: string;
  /** Pre-rendered RFC822 stored in R2; outbound is always raw. */
  source: 'raw';
  r2KeyOrInline: string;
  fromDomain: string;
  fromAddress: string;
  tenantId: string;
  domainId: string | null;
  mode: 'live' | 'test';
  retries: number;
}
