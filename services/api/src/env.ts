// Cloudflare environment bindings for polaris-email-api.
export interface Env {
  // Legacy single-D1 binding (Phase 0 keeps for backwards compat).
  DB: D1Database;
  // New sharded D1 bindings (Phase 0 plan: polaris-control / messages-YYYY-MM /
  // audit). Optional during the migration window — code that needs them falls
  // back to DB if they aren't set.
  DB_CONTROL?: D1Database;
  DB_MESSAGES?: D1Database;
  DB_AUDIT?: D1Database;

  R2: R2Bucket;
  KV_NONCE: KVNamespace;
  KV_IDEMPOTENCY: KVNamespace;
  KV_RATE_LIMIT: KVNamespace;
  KV_KEY_CACHE: KVNamespace;
  // I2 mitigation: best-effort revocation hint for the daemon's poller. Truth
  // lives in a Durable Object, not KV.
  KV_REVOKED_HINT?: KVNamespace;

  OUTBOUND_QUEUE: Queue<OutboundQueueMessage>;
  INBOUND_QUEUE: Queue<InboundQueueMessage>;
  FORENSIC: Fetcher;

  // Account-level Email Service binding (I9 — single binding, `from` parameter
  // selects sender domain). Optional during cutover; legacy services/out
  // continues to use per-domain `send_email` bindings until migrated.
  EMAIL?: {
    send(message: { from: string; to: string | string[]; raw: ReadableStream | string | Uint8Array }): Promise<{ id?: string }>;
  };

  // Per-principal revocation Durable Object (H1 + I2).
  REVOCATION_DO?: DurableObjectNamespace;

  VERIFY_ALGORITHMS: string;
  API_BASE_URL: string;
  BRIDGE_TAILNET_HOST: string;
  FANOUT_TAG: string;

  // Secrets via `wrangler secret put`:
  POLARIS_SECRET_A?: string;
  POLARIS_SECRET_B?: string;
  ARGON2_PEPPER?: string;
  /** HMAC master pepper for HKDF-derived per-tenant peppers (I13). */
  PEPPER_MASTER?: string;
  /** HMAC key shared with the submission daemon for /v1/bridge/* + /v1/send/raw. */
  DAEMON_HMAC_KEY?: string;
}

export interface OutboundQueueMessage {
  messageId: string;
  /** Pre-rendered RFC822 stored in R2; or structured body. */
  source: 'json' | 'raw';
  r2KeyOrInline: string;
  fromDomain: string;
  fromAddress: string;
  mode: 'live' | 'test';
  retries: number;
}

export interface InboundQueueMessage {
  messageId: string;
  mailboxId: string;
  serviceId: string | null;
}
