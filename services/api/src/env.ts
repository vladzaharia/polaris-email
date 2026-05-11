// Cloudflare environment bindings for polaris-email-api.
export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  KV_NONCE: KVNamespace;
  KV_IDEMPOTENCY: KVNamespace;
  KV_RATE_LIMIT: KVNamespace;
  KV_KEY_CACHE: KVNamespace;
  OUTBOUND_QUEUE: Queue<OutboundQueueMessage>;
  INBOUND_QUEUE: Queue<InboundQueueMessage>;
  FORENSIC: Fetcher;

  VERIFY_ALGORITHMS: string;
  API_BASE_URL: string;
  BRIDGE_TAILNET_HOST: string;
  FANOUT_TAG: string;

  // Secrets via `wrangler secret put`:
  POLARIS_SECRET_A?: string;
  POLARIS_SECRET_B?: string;
  ARGON2_PEPPER?: string;
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
