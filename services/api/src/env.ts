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
  /** Object key prefix for hourly audit anchors. Default `anchors/`. */
  ANCHOR_R2_PREFIX?: string;
  /** HMAC signing key (base64) used by the `anchor` cron. */
  ANCHOR_SIGNING_KEY?: string;
  /**
   * External Object-Lock target for audit anchors (Phase O1). Replaces the
   * prior `R2_ANCHORS` binding. Endpoint + bucket + region live in `vars`;
   * the access key / secret are set via `wrangler secret put`. Default
   * vendor: Backblaze B2 (`https://s3.<region>.backblazeb2.com`). See
   * `packages/object-lock` and `infra/terraform/README.md`.
   */
  ANCHOR_S3_ENDPOINT: string;
  ANCHOR_S3_BUCKET: string;
  ANCHOR_S3_REGION: string;
  ANCHOR_S3_ACCESS_KEY_ID?: string;
  ANCHOR_S3_SECRET_ACCESS_KEY?: string;
  /** Per-object retain-until offset, days. Default 2555 (7y). */
  ANCHOR_RETENTION_DAYS?: string;
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
  // Phase 2h: BRIDGE_HMAC_KEY (shared global) removed. Per-bridge HMAC
  // secrets live in `bridges.hmac_key_secret_name` (argon2 hash) plus
  // KV_KEY_CACHE under `bridge_plain:<id>` (plaintext, 1h TTL). See
  // services/api/src/bridge-auth.ts.

  // -- CF zone discovery + configure (cf-zones.ts) --------------------------
  /** CF API token. Needs Zone:Read across the account + Email Routing:Edit. */
  CF_API_TOKEN?: string;
  /** CF account ID — used to scope the zone listing + sender onboarding. */
  CF_ACCOUNT_ID?: string;
  /** Worker name the catch-all rule must target. Default `polaris-email-in`. */
  WORKER_NAME_INBOUND?: string;
}

export interface OutboundQueueMessage {
  messageId: string;
  /** Pre-rendered RFC822 stored in R2; outbound is always raw. */
  source: 'raw';
  r2KeyOrInline: string;
  fromDomain: string;
  fromAddress: string;
  /** Envelope recipients (RCPT TO). See `services/out/src/env.ts`. */
  envelopeTo?: string[];
  mailboxId: string;
  domainId: string | null;
  mode: 'live' | 'test';
  // `retries` removed in Phase 2b — services/out reads CF Workers Queues'
  // native `m.attempts` counter instead of trusting the queue body.
}
