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
  /** Webhook URL hit by `staleness` + `synthetic` cron alerts AND the W2d
   *  admin alert pipeline (services/api/src/lib/admin-alert.ts). */
  ALERT_WEBHOOK?: string;
  /** Comma-separated list of admin recipients to surface in alert payloads
   *  (the webhook channel echoes them so an email-adapter on the receiving
   *  end can route correctly). Defaults to hey@vlad.gg. */
  ADMIN_ALERT_RECIPIENTS?: string;
  /** Dedup TTL in seconds for admin alerts (W2d). Default 3600. */
  ADMIN_ALERT_DEDUP_TTL_SECONDS?: string;
  /** KV namespace used by W2d for dedupe lookups. Optional — when absent,
   *  every alert fires every time (the admin_alerts table itself still
   *  records every call). */
  KV_ADMIN_ALERTS?: KVNamespace;
  /** W3 — HMAC secret CF Email Service uses to sign bounce webhook events.
   *  Rotated independently from operator admin keys. */
  CF_EVENT_HMAC?: string;
  /** W4 — HMAC secret used to sign RFC 8058 one-click unsubscribe tokens.
   *  Rotated independently from operator admin keys; receiving MUAs use the
   *  token as a bearer credential. */
  UNSUB_HMAC_SECRET?: string;
  /** W4 — Public base URL used as the https form of List-Unsubscribe.
   *  Defaults to API_BASE_URL when unset. */
  UNSUB_PUBLIC_BASE_URL?: string;
  /** W4 — Mailto domain used for the mailto: form of List-Unsubscribe.
   *  Defaults to `plrs.im`. */
  UNSUB_MAILTO_HOST?: string;
  /** W6 — Platform DMARC RUA alias appended to the default dmarc_rua list.
   *  Customers' DMARC TXT records will then deliver aggregate reports to
   *  this alias, which routes to the W6 ingest pipeline. Defaults to
   *  `mailto:dmarc-rua@plrs.im`. */
  DMARC_RUA_PLATFORM_ALIAS?: string;
  /** Synthetic probe upper-bound latency, milliseconds, as a string. */
  MAX_LATENCY_MS?: string;

  // -- Policy engine (0019 / hybrid heuristics + LLM tiebreaker) -------------
  /** Daily Workers AI budget for the inbound policy tiebreaker. Default 5000. */
  POLICY_AI_DAILY_BUDGET?: string;
  /** Override the policy LLM model id. Default @cf/meta/llama-3.1-8b-instruct. */
  POLICY_MODEL?: string;
  /** Hard timeout on the policy LLM call, milliseconds. Default 10000. */
  POLICY_AI_TIMEOUT_MS?: string;
  /** Few-shot window size the daily moderation-feedback cron writes to KV.
   *  Default 20. Cap recommended ≤50 to keep prompt budget in check. */
  MODERATION_FEEDBACK_WINDOW_SIZE?: string;
  /** Soak-mode flag for the outbound gate. When `'false'`, block + hold
   *  verdicts downgrade to pass_warn (decisions are still recorded). Flip
   *  to `'true'` after the 7-day soak in P2. */
  POLICY_ENGINE_OUTBOUND_FULL?: string;
  /** Grace window (days) for the janitor's expunged_at sweep. */
  BRIDGE_EXPUNGE_GRACE_DAYS?: string;

  /**
   * Default TLS-RPT aggregation address (mailto: scheme) written to
   * `mail_domains.tlsrpt_rua` when a domain is onboarded. Falls back to
   * `mailto:tlsrpt@plrs.im` if unset. Phase C.
   */
  TLSRPT_DEFAULT_RUA?: string;

  // Secrets via `wrangler secret put`:
  /**
   * Cloudflare API token + account id used for DNS / Email Routing /
   * Workers Routes provisioning. Required for the domain-verify path and
   * all MTA-STS / TLS-RPT admin endpoints (Phase C). Wrangler-secret pair.
   */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
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
  // CF_API_TOKEN + CF_ACCOUNT_ID are declared above and reused here.
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
