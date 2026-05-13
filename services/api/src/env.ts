// Cloudflare environment bindings for polaris-email-api.
export interface Env {
  DB: D1Database;

  R2: R2Bucket;
  KV_NONCE: KVNamespace;
  KV_IDEMPOTENCY: KVNamespace;
  KV_RATE_LIMIT: KVNamespace;
  KV_KEY_CACHE: KVNamespace;
  /** Best-effort revocation hint for the daemon's poller. */
  KV_REVOKED_HINT?: KVNamespace;

  OUTBOUND_QUEUE: Queue<OutboundQueueMessage>;
  INBOUND_QUEUE: Queue<InboundQueueMessage>;
  FORENSIC: Fetcher;

  /** Per-principal revocation Durable Object. Synchronous truth for revocation state. */
  REVOCATION_DO: DurableObjectNamespace;

  VERIFY_ALGORITHMS: string;
  API_BASE_URL: string;

  // Secrets via `wrangler secret put`:
  POLARIS_SECRET_A?: string;
  POLARIS_SECRET_B?: string;
  ARGON2_PEPPER?: string;
  /** HMAC master pepper for HKDF-derived per-tenant peppers (I13). */
  PEPPER_MASTER?: string;
  /** HMAC key shared with the submission daemon for /v1/daemon/* + /v1/send/raw. */
  DAEMON_HMAC_KEY?: string;
}

export interface OutboundQueueMessage {
  messageId: string;
  /** Pre-rendered RFC822 stored in R2; or structured body. */
  source: 'json' | 'raw';
  r2KeyOrInline: string;
  fromDomain: string;
  fromAddress: string;
  tenantId: string;
  domainId: string | null;
  mode: 'live' | 'test';
  retries: number;
}

export interface InboundQueueMessage {
  messageId: string;
  domainId: string;
  tenantId: string | null;
}
