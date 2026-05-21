// Shared zod schemas + TypeScript types for polaris-mail.
//
// Mailbox-centric model. Tenant / environment / forensic / routing-rule
// types are gone; mailbox, sender, and receiver shapes replace them. See
// `services/api/migrations/0001_init.sql` for the canonical D1 schema.
import { z } from 'zod';
import {
  MAX_CUSTOM_HEADERS_PAYLOAD,
  MAX_HEADER_NAME_LENGTH,
  MAX_HEADER_VALUE_LENGTH,
  MAX_MESSAGE_SIZE_VERIFIED,
  MAX_NON_X_CUSTOM_HEADERS,
  MAX_RECIPIENTS,
  MAX_SUBJECT_LENGTH,
  PLATFORM_CONTROLLED_HEADERS,
  USE_API_FIELD_HEADERS,
  WHITELISTED_CUSTOM_HEADERS,
} from '@polaris-mail/mime';

// ---------- primitives ----------

export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'invalid ulid');
export const ServiceSlug = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const RuleSlug = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const Address = z.string().email().max(320);
export const DomainName = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/);
export const HostHeader = z.string().regex(/^[A-Za-z0-9._-]+$/);

// ---------- scope types ----------

// Sender scope (used by ad-hoc matchers — the actual binding is the
// api_key_sender_scopes junction table). Pattern shape kept identical to v1.
export const SenderScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exact'), pattern: Address }),
  z.object({
    kind: z.literal('glob'),
    pattern: z
      .string()
      .max(320)
      .refine((s) => s.includes('@'), { message: 'glob must include @' })
      .refine((s) => !/^\*[^@]/.test(s), {
        message: 'unanchored glob (must be `*@host` or `local-*@host`)',
      }),
  }),
  z.object({ kind: z.literal('regex'), pattern: z.string().max(512) }),
]);

export const KeyScope = z.enum([
  'send',
  'messages:read',
  'imap_bridge:read',
  'admin:rotate',
  'admin:read',
  // `admin:impersonate` gates the Wish/SSH server's bootstrap key:
  //   * use of the `X-Polaris-OBO` header,
  //   * the `GET /v1/admin/operators/lookup` route used by the Wish server.
  // The bootstrap key is expected to hold ONLY this scope; impersonation
  // grants the *operator's* scopes for the request, not the bootstrap key's.
  'admin:impersonate',
]);
export type KeyScope = z.infer<typeof KeyScope>;
export const KeyScopes = z.array(KeyScope).min(1);

// ---------- error envelope ----------

export const ErrorCode = z.enum([
  'bad_request',
  'bad_content_type',
  'bad_signature',
  'key_propagating',
  'clock_skew',
  'key_revoked',
  'scope_violation',
  'nonce_replay',
  'idempotency_conflict',
  'domain_not_verified',
  'recipient_rejected',
  'rate_limited',
  'too_many_requests',
  'cf_upstream',
  'degraded',
  'not_found',
  'unauthorized',
  'forbidden',
  'conflict',
  // `already_bootstrapped` is a specialised `conflict` returned only by
  // POST /v1/admin/bootstrap when the genesis admin key already exists.
  // Distinct from `conflict` so the Go CLI's genesis-seal flow can map
  // it to an idempotent skip instead of an operator-visible failure.
  'already_bootstrapped',
  // typed CF Email Service limit failures. Each is emitted by
  // SendRequest's superRefine (and downstream services) so the API layer
  // can render a precise error envelope without parsing free-form text.
  'too_many_recipients',
  'subject_too_long',
  'message_too_large',
  'header_not_allowed',
  'header_too_long',
  'too_many_custom_headers',
  'custom_headers_too_large',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    retryable: z.boolean(),
    request_id: z.string(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

// ---------- webhook events ----------

// v2 envelope: message.* events only. credential.* events were dropped with
// the tenant cleanup.
export const WebhookEventType = z.enum([
  'message.received',
  'message.sent',
  'message.delivered',
  'message.bounced',
  'message.failed',
]);
export type WebhookEventType = z.infer<typeof WebhookEventType>;

// ---------- forbidden headers ----------
//
// Headers the submitter has no business setting on the JSON SendRequest path.
// Sourced from `@polaris-mail/mime/limits.ts` — the canonical CF Email
// Service list — so changes to CF's rules propagate via that one file.
// Members come from PLATFORM_CONTROLLED_HEADERS (DKIM-Signature, Date,
// Message-ID, ARC-*, etc.) plus USE_API_FIELD_HEADERS (From/To/Cc/Bcc/
// Subject/Reply-To, which belong as typed SendRequest fields). All lowercase.
export const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  ...PLATFORM_CONTROLLED_HEADERS,
  ...USE_API_FIELD_HEADERS,
]);

// ---------- custom-header validation ----------

/**
 * The set of `header_not_allowed` rejection reasons. Extracted as a const
 * tuple so consumers can iterate, switch exhaustively, and so the typed
 * `header_not_allowed:<reason>` template literal in SendRequest.superRefine
 * is checked against the same canonical set (rather than string-glued).
 */
export const HEADER_REASON_CODES = [
  'platform_controlled',
  'use_api_field',
  'name_too_long',
  'invalid_x_format',
  'not_whitelisted',
] as const;
export type HeaderReasonCode = (typeof HEADER_REASON_CODES)[number];

export type ValidateHeaderResult = { ok: true } | { ok: false; reason: HeaderReasonCode };

/**
 * Validate a custom header NAME against CF Email Service rules. Does NOT
 * validate the value (caller checks value length separately).
 *
 * Order of precedence:
 *   1. name length > MAX_HEADER_NAME_LENGTH → name_too_long
 *   2. lowercased name in PLATFORM_CONTROLLED_HEADERS → platform_controlled
 *   3. lowercased name in USE_API_FIELD_HEADERS → use_api_field
 *   4. name starts with `X-` / `x-`:
 *      - matches /^X-[A-Za-z0-9\-_]+$/i → ok
 *      - else → invalid_x_format
 *   5. lowercased name in WHITELISTED_CUSTOM_HEADERS → ok
 *   6. else → not_whitelisted
 */
export function validateHeaderAllowed(name: string): ValidateHeaderResult {
  if (name.length > MAX_HEADER_NAME_LENGTH) return { ok: false, reason: 'name_too_long' };
  const lc = name.toLowerCase();
  if (PLATFORM_CONTROLLED_HEADERS.has(lc)) return { ok: false, reason: 'platform_controlled' };
  if (USE_API_FIELD_HEADERS.has(lc)) return { ok: false, reason: 'use_api_field' };
  if (/^x-/i.test(name)) {
    return /^X-[A-Za-z0-9\-_]+$/i.test(name)
      ? { ok: true }
      : { ok: false, reason: 'invalid_x_format' };
  }
  if (WHITELISTED_CUSTOM_HEADERS.has(lc)) return { ok: true };
  return { ok: false, reason: 'not_whitelisted' };
}

// ---------- mailbox plane ----------

export const Mailbox = z.object({
  id: Ulid,
  name: z.string().min(1).max(120),
  description: z.string().nullable().optional(),
  default_sender_id: Ulid.nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  disabled_at: z.string().nullable().optional(),
});
export type Mailbox = z.infer<typeof Mailbox>;

export const MailboxSender = z.object({
  id: Ulid,
  mailbox_id: Ulid,
  domain_id: Ulid,
  address: Address,
  local_part: z.string().nullable().optional(),
  display_name: z.string().nullable().optional(),
  default_for_mailbox: z.number().int().min(0).max(1),
  created_at: z.string(),
  disabled_at: z.string().nullable().optional(),
});
export type MailboxSender = z.infer<typeof MailboxSender>;

export const MailboxReceiverAction = z.enum(['webhook', 'forward', 'drop']);
export type MailboxReceiverAction = z.infer<typeof MailboxReceiverAction>;

export const MailboxReceiver = z.object({
  id: Ulid,
  mailbox_id: Ulid,
  domain_id: Ulid,
  priority: z.number().int(),
  address_pattern: z.string().min(1).max(512),
  action: MailboxReceiverAction,
  webhook_sub_id: Ulid.nullable().optional(),
  forward_to: z.string().nullable().optional(),
  enabled: z.number().int().min(0).max(1),
  created_at: z.string(),
  disabled_at: z.string().nullable().optional(),
});
export type MailboxReceiver = z.infer<typeof MailboxReceiver>;

// ---------- mail domain ----------

export const MailDomainStatus = z.enum(['pending', 'verifying', 'verified', 'failed', 'disabled']);
export type MailDomainStatus = z.infer<typeof MailDomainStatus>;

export const DmarcPolicy = z.enum(['none', 'quarantine', 'reject']);

// Phase C (MTA-STS + TLS-RPT) extension — mirrors columns added by migration
// 0007. The flat shape is sufficient: there is no per-mode required-field
// asymmetry (every field is independently nullable / defaulted), so a
// discriminated union on `mta_sts_mode` would only add ceremony without
// catching extra invalid rows. The verify flow distinguishes
// missing / drift / verified states via free-form hint text on
// `VerifyCheck.actual` (see VerifyCheck below).
export const MailDomain = z.object({
  id: Ulid,
  zone_id: Ulid,
  parent_domain_id: Ulid.nullable(),
  name: DomainName,
  status: MailDomainStatus,
  wildcard_subdomains: z.number().int(),
  dmarc_policy: z.string().nullable(),
  dmarc_rua: z.string().nullable(),
  inbound_enabled: z.number().int(),
  outbound_enabled: z.number().int(),
  provider: z.string(),
  cf_zone_id: z.string().nullable(),
  dkim_selector: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  verified_at: z.string().nullable(),
  last_verify_check_at: z.string().nullable(),
  disabled_at: z.string().nullable(),
  // MTA-STS (RFC 8461) + TLS-RPT (RFC 8460). See
  // services/api/migrations/0007_mta_sts.sql for the canonical D1 column
  // definitions. `tlsrpt_enabled` is stored as an INTEGER 0/1 to match the
  // existing inbound_enabled / outbound_enabled / default_for_mailbox pattern
  // (SQLite has no native boolean). The PATCH /v1/admin/domains/:id surface
  // accepts a boolean for this field; the route layer coerces it.
  mta_sts_mode: z.enum(['none', 'testing', 'enforce']),
  mta_sts_policy_id: z.string().nullable(),
  mta_sts_max_age: z.number().int().nonnegative(),
  mta_sts_verified_at: z.string().nullable(),
  tlsrpt_enabled: z.number().int().min(0).max(1),
  tlsrpt_rua: z.string().nullable(),
  tlsrpt_verified_at: z.string().nullable(),
});
export type MailDomain = z.infer<typeof MailDomain>;

export const CreateMailDomainRequest = z.object({
  name: DomainName,
  dkim_selector: z.string().min(1).max(63).optional(),
  dmarc_policy: DmarcPolicy.optional(),
  dmarc_rua: z.string().max(320).optional(),
});

export const UpdateMailDomainRequest = z.object({
  cf_zone_id: z.string().max(64).optional(),
  status: MailDomainStatus.optional(),
  dmarc_policy: DmarcPolicy.optional(),
  dmarc_rua: z.string().max(320).optional(),
  dkim_selector: z.string().min(1).max(63).optional(),
  // MTA-STS + TLS-RPT toggles. `tlsrpt_enabled` is a boolean in
  // the request body but is persisted as INTEGER 0/1 in `mail_domains`; the
  // route layer (C.10) performs the coercion. Switching MTA-STS mode itself
  // is normally routed through the dedicated lifecycle endpoints
  // (`POST .../mta-sts/enable|disable|promote`) so they can also publish
  // the policy file / KV record; accepting it here keeps the generic PATCH
  // surface usable for bulk operator scripts.
  mta_sts_mode: z.enum(['none', 'testing', 'enforce']).optional(),
  mta_sts_max_age: z.number().int().nonnegative().optional(),
  tlsrpt_enabled: z.boolean().optional(),
  tlsrpt_rua: z.string().optional(),
});

// ---------- domain verify ----------
//
// Canonical shape for the per-check rows emitted by
// `POST /v1/admin/domains/:id/verify` (and the matching cf-api MTA-STS
// verifier). Extracted to the schema package so the API route, cf-api helpers,
// and panel client can share the same `VerifyCheck[]` type without each
// re-declaring it.
//
// `actual` carries free-form hint text in addition to the observed value so
// the verify flow can express three failure flavours uniformly:
//   - "missing"     — record/policy hasn't been provisioned yet
//                     (e.g. "not provisioned — call POST .../mta-sts/enable")
//   - "drift"       — provisioned but DNS / KV / DB are out of sync
//                     (e.g. "mode=testing (drift: published policy differs)")
//   - "unreachable" — DoH / HTTPS fetch failed entirely
// Per the user note for MTA-STS specifically: records require MANUAL
// provisioning via the dedicated admin endpoints, unlike DKIM /
// SPF / DMARC which CF auto-publishes during Email Routing onboarding. The
// flat string-actual encoding keeps the panel rendering simple while still
// expressing this distinction.
export const VerifyCheck = z.object({
  name: z.string(),
  ok: z.boolean(),
  expected: z.string(),
  actual: z.string(),
});
export type VerifyCheck = z.infer<typeof VerifyCheck>;

export const VerifyResponse = z.object({
  id: Ulid,
  status: MailDomainStatus,
  checks: z.array(VerifyCheck),
  message: z.string().optional(),
  verified_at: z.number().int().optional(),
});
export type VerifyResponse = z.infer<typeof VerifyResponse>;

// ---------- credential plane ----------

// Operator principals (migration 0024) reuse the `'api_key'` kind —
// they behave identically and anchor to the sentinel `_polaris_operators`
// mailbox. The disambiguation lives in the `operators.api_key_id` FK,
// not in the principals schema.
export const PrincipalKind = z.enum(['api_key', 'smtp_cred']);
export type PrincipalKind = z.infer<typeof PrincipalKind>;

export const Principal = z.object({
  id: Ulid,
  mailbox_id: Ulid,
  kind: PrincipalKind,
  display_name: z.string().nullable().optional(),
  created_at: z.string(),
  disabled_at: z.string().nullable().optional(),
});
export type Principal = z.infer<typeof Principal>;

// Internal (D1 row) shape. `secret_argon2id` is the persisted hash only — the
// plaintext secret is returned by POST /v1/admin/api-keys exactly once and
// NEVER persisted in the clear. GET responses use `ApiKeyMetadata`.
export const ApiKey = z.object({
  id: Ulid,
  principal_id: Ulid,
  prefix: z.string(),
  secret_argon2id: z.string(),
  scopes: z.string(),
  rate_limit_per_min: z.number().int().positive(),
  status: z.enum(['primary', 'secondary', 'revoked']),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  last_used_ip: z.string().nullable(),
  last_used_ua: z.string().nullable(),
  revoked_at: z.string().nullable(),
  disabled_at: z.string().nullable().optional(),
});
export type ApiKey = z.infer<typeof ApiKey>;

// Public GET response shape for /v1/admin/api-keys. Strips both the stored
// hash (`secret_argon2id`) and any hint of the plaintext. Per A11/B6.
export const ApiKeyMetadata = z.object({
  id: Ulid,
  principal_id: Ulid,
  prefix: z.string(),
  scopes: z.string(),
  rate_limit_per_min: z.number().int().positive().optional(),
  status: z.enum(['primary', 'secondary', 'revoked']),
  created_at: z.string(),
  last_used_at: z.string().nullable().optional(),
  last_used_ip: z.string().nullable().optional(),
  last_used_ua: z.string().nullable().optional(),
  revoked_at: z.string().nullable().optional(),
  disabled_at: z.string().nullable().optional(),
});
export type ApiKeyMetadata = z.infer<typeof ApiKeyMetadata>;

// One-shot response for POST /v1/admin/api-keys (issue). The `key_secret`
// plaintext is shown ONCE; subsequent GETs return `ApiKeyMetadata` only.
export const ApiKeyCreatedResponse = z.object({
  key_id: Ulid,
  key_secret: z.string(),
  prefix: z.string(),
  created_at: z.number().int().nonnegative(),
});
export type ApiKeyCreatedResponse = z.infer<typeof ApiKeyCreatedResponse>;

// One-shot response for POST /v1/admin/api-keys/:id/rotate. Same read-once
// contract — `new_key_secret` is shown only here.
export const ApiKeyRotatedResponse = z.object({
  new_key_id: Ulid,
  new_key_secret: z.string(),
  prev_status: z.enum(['planned', 'emergency']),
});
export type ApiKeyRotatedResponse = z.infer<typeof ApiKeyRotatedResponse>;

// Internal (D1 row) shape. `bcrypt_hash` is the persisted hash only — the
// plaintext SMTP password is returned by POST /v1/admin/senders/:id/smtp-
// credentials exactly once and never persisted in the clear.
export const SmtpCredential = z.object({
  id: Ulid,
  principal_id: Ulid,
  sender_id: Ulid,
  bridge_id: Ulid.nullable().optional(),
  username: Address,
  bcrypt_hash: z.string(),
  created_at: z.string(),
  last_used_at: z.string().nullable().optional(),
  disabled_at: z.string().nullable().optional(),
});
export type SmtpCredential = z.infer<typeof SmtpCredential>;

// Public GET response shape for SMTP-credential listings. Strips the bcrypt
// hash. Per A11/B6.
export const SmtpCredentialMetadata = z.object({
  id: Ulid,
  principal_id: Ulid,
  sender_id: Ulid.nullable().optional(),
  bridge_id: Ulid.nullable().optional(),
  username: Address,
  created_at: z.string(),
  last_used_at: z.string().nullable().optional(),
  disabled_at: z.string().nullable().optional(),
});
export type SmtpCredentialMetadata = z.infer<typeof SmtpCredentialMetadata>;

// One-shot response for POST /v1/admin/senders/:id/smtp-credentials.
export const SmtpCredentialCreatedResponse = z.object({
  id: Ulid,
  username: Address,
  secret: z.string(),
  created_at: z.number().int().nonnegative(),
});
export type SmtpCredentialCreatedResponse = z.infer<typeof SmtpCredentialCreatedResponse>;

// ---------- webhook subs ----------

// Internal (D1 row) shape. The polaris API itself signs every webhook
// delivery, so the plaintext `secret` is retained server-side by design.
// Public GET responses use `WebhookSubMetadata` and never surface `secret`
// or `secret_prev`.
export const WebhookSub = z.object({
  id: Ulid,
  mailbox_id: Ulid,
  url: z.string().url(),
  kind: z.enum(['external', 'tailnet']),
  secret: z.string(),
  secret_prev: z.string().nullable(),
  events: z.string(), // JSON array of WebhookEventType
  paused_at: z.string().nullable(),
  created_at: z.string(),
  disabled_at: z.string().nullable(),
});
export type WebhookSub = z.infer<typeof WebhookSub>;

// Public GET response shape for /v1/admin/webhook-subs. Omits the signing
// `secret` + `secret_prev`. Per A11.
export const WebhookSubMetadata = z.object({
  id: Ulid,
  mailbox_id: Ulid,
  url: z.string().url(),
  kind: z.enum(['external', 'tailnet']),
  events: z.string(),
  paused_at: z.string().nullable(),
  created_at: z.string(),
  disabled_at: z.string().nullable(),
});
export type WebhookSubMetadata = z.infer<typeof WebhookSubMetadata>;

// One-shot response for POST /v1/admin/webhook-subs. The plaintext signing
// secret is shown ONCE; subscribers store it locally to verify deliveries.
export const WebhookSubCreatedResponse = z.object({
  id: Ulid,
  secret: z.string(),
});
export type WebhookSubCreatedResponse = z.infer<typeof WebhookSubCreatedResponse>;

// Bridge (formerly "daemon", renamed in B4) — internal row shape. The
// argon2id hash of the HMAC key lives in `hmac_key_secret_name` (legacy
// column name retained; the table itself is `bridges` after 0006).
export const Bridge = z.object({
  id: Ulid,
  name: z.string().min(1).max(120),
  hmac_key_secret_name: z.string().nullable().optional(),
  access_token_id: z.string().nullable().optional(),
  last_seen_at: z.string().nullable().optional(),
  created_at: z.string(),
  disabled_at: z.string().nullable().optional(),
});
export type Bridge = z.infer<typeof Bridge>;

// Public GET response shape for /v1/admin/bridges. Omits the stored hash.
// Per A11/B6 the hash itself is not user-actionable, so we omit it.
export const BridgeMetadata = z.object({
  id: Ulid,
  name: z.string().min(1).max(120),
  access_token_id: z.string().nullable().optional(),
  last_seen_at: z.string().nullable().optional(),
  created_at: z.string(),
  disabled_at: z.string().nullable().optional(),
});
export type BridgeMetadata = z.infer<typeof BridgeMetadata>;

// One-shot responses for POST /v1/admin/bridges (register) and
// POST /v1/admin/bridges/:id/rotate. The HMAC key plaintext is shown ONCE.
export const BridgeCreatedResponse = z.object({
  id: Ulid,
  name: z.string().min(1).max(120),
  hmac_key: z.string(),
});
export type BridgeCreatedResponse = z.infer<typeof BridgeCreatedResponse>;

export const BridgeRotatedResponse = z.object({
  id: Ulid,
  hmac_key: z.string(),
});
export type BridgeRotatedResponse = z.infer<typeof BridgeRotatedResponse>;

// ---------- message plane ----------

export const MessageDirection = z.enum(['in', 'out']);
export type MessageDirection = z.infer<typeof MessageDirection>;

export const MessageStatus = z.enum([
  'received',
  'mime_stored',
  'queued',
  'sending',
  'sent',
  'bounced',
  'delivered',
  'failed',
]);
export type MessageStatus = z.infer<typeof MessageStatus>;

export const MessageAttachment = z.object({
  filename: z.string(),
  content_type: z.string(),
  size_bytes: z.number().int().nonnegative(),
  // Per B5: `url` is the public, content-addressed URL on the R2 custom
  // domain `r2.mail.plrs.im`. It is absolute, has no expiry, and serves the
  // raw attachment bytes. The signed-URL endpoint that previously minted
  // short-lived attachment URLs is removed; unguessability comes from the
  // SHA-256 in the key.
  url: z.string().url().optional(),
  // Inline-small fallback: when the attachment is small enough we still ship
  // bytes in the response body for one-shot consumers.
  content_base64: z.string().optional(),
});
export type MessageAttachment = z.infer<typeof MessageAttachment>;

export const MessageAuth = z.object({
  spf: z.string().optional(),
  dkim: z.string().optional(),
  dmarc: z.string().optional(),
  remote_ip: z.string().optional(),
});
export type MessageAuth = z.infer<typeof MessageAuth>;

// Unified inbound/outbound message JSON shape.
// Bodies (`text`, `html`, attachment content) are optional and resolved at
// read time. `parsed_json` on the D1 row caches everything except the
// attachment bodies themselves.
export const Message = z.object({
  id: Ulid,
  mailbox_id: Ulid,
  direction: MessageDirection,
  status: MessageStatus,
  from: z.string(),
  // Bare email address extracted from the From: header (also the value indexed
  // by `from_addr_normalized` in `messages`). Populated whenever the runtime
  // can resolve it; absent for responses that strip envelope metadata.
  from_addr: z.string().optional(),
  to: z.array(z.string()),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string().optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  // Public, content-addressed URL for the raw RFC822 body on the R2 custom
  // domain `r2.mail.plrs.im`. Absolute, no expiry. Always populated for
  // stored messages; consumers fetch the URL directly without HMAC.
  body_url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  attachments: z.array(MessageAttachment),
  header_message_id: z.string().optional(),
  thread_id: z.string().optional(),
  auth: MessageAuth.optional(),
  body_bytes: z.number().int().nonnegative().optional(),
  attachments_total_bytes: z.number().int().nonnegative().optional(),
  received_at_bridge: z.string().optional(),
  received_at_api: z.string().optional(),
  queued_at: z.string().optional(),
  sending_at: z.string().optional(),
  sent_at: z.string().optional(),
  delivered_at: z.string().optional(),
  failed_at: z.string().optional(),
  bounce_metadata: z.unknown().optional(),
  last_error: z.string().optional(),
  created_at: z.string(),
  // IMAP / bridge per-mailbox state. Populated when the response is rendered
  // for a mailbox-scoped caller (POST /v1/messages/get, PATCH /v1/messages/:id,
  // the mail-bridge mirror bootstrap). See `MailboxMessageState` for the
  // canonical row shape backing these fields; `MessageFlag` (defined below)
  // is the per-element validator if you want to validate flags strictly.
  flags: z.array(z.string()).optional(),
  read_at: z.string().nullable().optional(),
  change_id: z.number().int().nonnegative().optional(),
});
export type Message = z.infer<typeof Message>;

export const MessageDelivery = z.object({
  message_id: Ulid,
  webhook_sub_id: Ulid,
  status: z.enum(['pending', 'succeeded', 'failed', 'dlq']),
  attempts: z.number().int().nonnegative(),
  next_attempt_at: z.string().nullable(),
  last_error: z.string().nullable(),
  last_response_code: z.number().int().nullable(),
  created_at: z.string(),
});

// ---------- webhook envelope (v2) ----------

export const WebhookEnvelope = z.object({
  event_id: Ulid,
  event: WebhookEventType,
  occurred_at: z.string(),
  message: Message,
});
export type WebhookEnvelope = z.infer<typeof WebhookEnvelope>;

// ---------- send request (POST /v1/messages, JSON body) ----------

const SendRequestAttachment = z.object({
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1).max(255),
  content_base64: z.string(),
});

/**
 * W4 — Stream type. Controls whether the outbound MIME builder injects
 * List-Unsubscribe headers (RFC 8058 one-click). Defaults to 'transactional'
 * so accidental classification doesn't let recipients unsubscribe from
 * password resets.
 *
 *   transactional — operator-to-user mail (receipts, password resets,
 *                   delivery notifications). NO List-Unsubscribe injected
 *                   (Gmail/Yahoo explicitly exempt; injecting them lets a
 *                   recipient accidentally unsubscribe from critical mail).
 *   marketing     — bulk operator-to-list mail. Auto-injects
 *                   List-Unsubscribe (mailto + https) + List-Unsubscribe-Post.
 *                   Gmail/Yahoo 2026 require this for bulk senders.
 *   agent         — AI-agent reply / conversational mail. NO injection
 *                   (each message is a reply in an active conversation;
 *                   the recipient already opted in to talking to the agent).
 */
export const StreamType = z.enum(['transactional', 'marketing', 'agent']);
export type StreamType = z.infer<typeof StreamType>;

export const SendRequest = z
  .object({
    from: z.string(),
    to: z.array(z.string()).min(1),
    cc: z.array(z.string()).optional(),
    bcc: z.array(z.string()).optional(),
    subject: z.string().optional(),
    text: z.string().optional(),
    html: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    attachments: z.array(SendRequestAttachment).optional(),
    reply_to: z.string().optional(),
    idempotency_key: z.string().optional(),
    /** W4 — Stream classification. See StreamType for header-injection rules. */
    stream_type: StreamType.default('transactional'),
    /** W9 — Threading helpers. When provided, the API server auto-synthesizes
     *  the In-Reply-To + References headers from the parent message's
     *  header_message_id. Callers do NOT need to manage Message-ID arithmetic. */
    in_reply_to_message_id: Ulid.optional(),
    thread_id: z.string().min(1).max(120).optional(),
  })
  // enforce CF Email Service caps. Each issue's `message` is
  // shaped as `"<error_code>:<detail>"` so the API layer can extract the
  // typed code via `result.error.issues[i].message.split(':')[0]` and map
  // it to an `ErrorCode` without inspecting free-form text.
  .superRefine((req, ctx) => {
    // (1) recipient cap — sum of to + cc + bcc must not exceed MAX_RECIPIENTS.
    const recipCount = req.to.length + (req.cc?.length ?? 0) + (req.bcc?.length ?? 0);
    if (recipCount > MAX_RECIPIENTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: `too_many_recipients:${recipCount} exceeds ${MAX_RECIPIENTS}`,
      });
    }

    // (2) subject length cap.
    if (req.subject != null && req.subject.length > MAX_SUBJECT_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['subject'],
        message: `subject_too_long:${req.subject.length} exceeds ${MAX_SUBJECT_LENGTH}`,
      });
    }

    // (3-5) custom headers.
    if (req.headers) {
      const encoder = new TextEncoder();
      let nonXCount = 0;
      let payloadBytes = 0;

      for (const [name, value] of Object.entries(req.headers)) {
        // (3a) name allowed?
        const allowed = validateHeaderAllowed(name);
        if (!allowed.ok) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['headers', name],
            message: `header_not_allowed:${allowed.reason}`,
          });
        }

        // (3b) value byte length cap.
        const nameBytes = encoder.encode(name).byteLength;
        const valueBytes = encoder.encode(value).byteLength;
        if (valueBytes > MAX_HEADER_VALUE_LENGTH) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['headers', name],
            message: `header_too_long:${valueBytes}`,
          });
        }

        // (4) non-X header count.
        if (!/^x-/i.test(name)) nonXCount++;

        // (5) total payload accumulator: `Name: Value\r\n` per header.
        payloadBytes += nameBytes + 2 + valueBytes + 2;
      }

      if (nonXCount > MAX_NON_X_CUSTOM_HEADERS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['headers'],
          message: `too_many_custom_headers:${nonXCount}`,
        });
      }

      if (payloadBytes > MAX_CUSTOM_HEADERS_PAYLOAD) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['headers'],
          message: `custom_headers_too_large:${payloadBytes}`,
        });
      }
    }

    // (6) Body-size upper-bound pre-check. composeFromJson allocates a
    // single ArrayBuffer the size of the canonical MIME; we want to reject
    // an obvious overrun at the zod boundary before that allocation so a
    // hostile authenticated caller can't force a 100MB+ heap spike. This
    // is a CONSERVATIVE upper bound — base64 attachment content is the
    // wire-size of the encoded bytes (1.33x the raw payload), so summing
    // raw text/html + base64 content lengths gives a lower bound on what
    // the canonical MIME will be. If even that lower bound exceeds the
    // verified-domain cap, no MIME shape can fit. The precise check on
    // the canonical-serialized bytes still lives in services/api at
    // routes/messages.ts:452-464 as the final authoritative gate.
    let bodyEstimate = 0;
    if (req.text) bodyEstimate += new TextEncoder().encode(req.text).byteLength;
    if (req.html) bodyEstimate += new TextEncoder().encode(req.html).byteLength;
    if (req.attachments) {
      for (const a of req.attachments) {
        // content_base64 is the WIRE size of the encoded attachment — the
        // canonical MIME will carry these bytes verbatim in a base64-
        // encoded part. Length-as-bytes is correct because base64 is ASCII.
        bodyEstimate += a.content_base64.length;
      }
    }
    if (bodyEstimate > MAX_MESSAGE_SIZE_VERIFIED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: `message_too_large:${bodyEstimate} exceeds ${MAX_MESSAGE_SIZE_VERIFIED} (pre-compose estimate)`,
      });
    }
  });
export type SendRequest = z.infer<typeof SendRequest>;

// ---------- idempotency ----------

export const IdempotencyClaim = z.object({
  key: z.string(),
  mailbox_id: Ulid,
  principal_id: Ulid.nullable().optional(),
  message_id: Ulid.nullable().optional(),
  expires_at: z.string().nullable().optional(),
  created_at: z.string(),
});
export type IdempotencyClaim = z.infer<typeof IdempotencyClaim>;

// ---------- audit log ----------
//
// AuditAction must stay in sync with the CHECK constraint on `audit_log.action`
// in `services/api/migrations/0001_init.sql`. Adding a new action requires a
// new migration; removing one is not allowed (the constraint must accept every
// action that appears in the historic log).
export const AuditAction = z.enum([
  // bootstrap
  'bootstrap.consume',
  // PR 7 genesis-seal records the WebAuthn enrolment completion as an
  // audit row (migration 0023_audit_action_webauthn_enrolled.sql).
  'bootstrap.webauthn_enrolled',
  // mailbox CRUD
  'mailbox.create',
  'mailbox.update',
  'mailbox.disable',
  'mailbox.delete',
  // mailbox bridge ops
  'mailbox.expunge',
  // sender CRUD
  'mailbox_sender.create',
  'mailbox_sender.update',
  'mailbox_sender.disable',
  'mailbox_sender.delete',
  // legacy sender names kept until services migrate (matches 0001_init.sql)
  'email_sender.create',
  'email_sender.disable',
  // receiver CRUD
  'mailbox_receiver.create',
  'mailbox_receiver.update',
  'mailbox_receiver.disable',
  'mailbox_receiver.delete',
  // legacy receiver names (matches 0001_init.sql)
  'routing_rule.create',
  'routing_rule.update',
  'routing_rule.delete',
  // credential lifecycle
  'api_key.issue',
  'api_key.rotate',
  'api_key.rotate.emergency',
  'api_key.revoke',
  'api_key.revoke.emergency',
  'smtp_credential.issue',
  'smtp_credential.disable',
  'smtp_credential.rotate',
  // unified mailbox credentials
  'mailbox_credential.issue',
  'mailbox_credential.rotate',
  'mailbox_credential.disable',
  'dry_run_rotate',
  // bridge lifecycle (renamed from daemon.* in B4)
  'bridge.register',
  'bridge.rotate',
  'bridge.deregister',
  // domain + DKIM
  'domain.create',
  'domain.update',
  'domain.disable',
  'domain.verify',
  'domain.verify_incomplete',
  'domain.dkim_rotate',
  // domain inbound/outbound toggles
  'domain.inbound.enable',
  'domain.inbound.disable',
  'domain.outbound.enable',
  'domain.outbound.disable',
  // dkim_key direct events
  'dkim_key.create',
  'dkim_key.activate',
  'dkim_key.retire',
  // webhook subs + DLQ
  'webhook_sub.create',
  'webhook_sub.update',
  'webhook_sub.delete',
  'webhook_sub.replay',
  'webhook_sub.test',
  'webhook_sub.rotate',
  // messages (submit/receive/lifecycle)
  'message.submitted',
  'message.received',
  'message.marked_read',
  'message.expunged',
  // rate limiting
  'rate_limit.exceeded',
  // CF zone discover + configure (cf-zones.ts)
  'cf_zone.configure',
  // MTA-STS + TLS-RPT. Lifecycle audit hits for the dedicated
  // policy-management endpoints; mirrors the additions to the audit_log
  // CHECK constraint in services/api/migrations/0009_mta_sts.sql.
  'mta_sts.enable',
  'mta_sts.disable',
  'mta_sts.promote',
  'tls_rpt.enable',
  'tls_rpt.disable',
  // Suppressions (W1 — migration 0010_suppressions.sql).
  // `suppression.create` and `suppression.disable` cover admin/CLI/panel
  // toggles; `suppression.import` is bulk loads from CSV / legacy systems;
  // `message.suppressed` and `message.sender_suppressed` are emitted by
  // the outbound enforcement path so the audit log records every drop.
  'suppression.create',
  'suppression.disable',
  'suppression.import',
  'message.suppressed',
  'message.sender_suppressed',
  // W2 — Postmaster/abuse/webmaster auto-receivers (migration 0011).
  'abuse_event.record',
  // W2d — Admin alert pipeline (migration 0012).
  'admin.alert.sent',
  // W2c — Sender abuse profile + escalating suppression (migration 0013).
  'sender_abuse_profile.tier_advance',
  'sender.suppress_auto',
  // W5 — TLS-RPT receiver (migration 0014).
  'tls_rpt_report.ingest',
  // W6 — DMARC RUA receiver (migration 0015).
  'dmarc_aggregate_report.ingest',
  // W8 — DMARC promotion state machine (migration 0016).
  'dmarc.promote',
  'dmarc.pause',
  'dmarc.rollback',
  'dmarc.claim_management',
  // W2b — LLM-assisted triage (migration 0018).
  'triage.classify',
  'triage.operator_override',
  // Hybrid Policy Engine (migration 0019).
  'policy.decide',
  'policy.override',
  'message.held',
  'message.held_release',
  'message.held_drop',
  'moderation.feedback_recorded',
  'inbound_sender_block.create',
  'inbound_sender_block.delete',
  // Legacy tenant lifecycle (kept in the audit_log CHECK from
  // 0001_init.sql onward for historic rows; the runtime equivalents
  // are mailbox.*). Listing them here closes the Zod-vs-CHECK gap so
  // historic audit rows parse cleanly through AuditAction.
  'tenant.create',
  'tenant.update',
  'tenant.disable',
  'tenant.rotate_pepper',
  // Operator lifecycle (migration 0025). `operator.*` covers admin actions
  // managing the operator roster; `auth.*` covers per-session events
  // (CLI login/logout).
  'operator.create',
  'operator.update',
  'operator.disable',
  'operator.rotate_key',
  'operator.rotate_pubkey',
  'auth.login',
  'auth.logout',
]);
export type AuditAction = z.infer<typeof AuditAction>;

export const AuditRow = z.object({
  id: z.number().int(),
  actor: z.string(),
  action: AuditAction,
  target: z.string().nullable(),
  meta: z.string(),
  prev_hash: z.string(),
  row_hash: z.string(),
  at: z.number().int(),
});

// ---------- admin REST shapes ----------

export const CreateMailboxRequest = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
});
export type CreateMailboxRequest = z.infer<typeof CreateMailboxRequest>;

export const IssueApiKeyRequest = z.object({
  mailbox_id: Ulid,
  display_name: z.string().min(1).max(120).optional(),
  // Optional set of mailbox_sender IDs to restrict the key to. Empty/omitted =
  // unrestricted (key can send from any sender in the mailbox).
  sender_ids: z.array(Ulid).optional(),
  scopes: KeyScopes.default(['send']),
  rate_limit_per_min: z.number().int().positive().max(100000).default(1000),
});
export type IssueApiKeyRequest = z.infer<typeof IssueApiKeyRequest>;

export const RotateRequest = z.object({
  mode: z.enum(['planned', 'emergency']),
  reason: z.string().max(500).optional(),
  new_label: z.string().max(120).optional(),
});
export type RotateRequest = z.infer<typeof RotateRequest>;

export const CreateWebhookSubRequest = z.object({
  mailbox_id: Ulid,
  url: z.string().url(),
  kind: z.enum(['external', 'tailnet']),
  events: z.array(WebhookEventType).min(1),
});
export type CreateWebhookSubRequest = z.infer<typeof CreateWebhookSubRequest>;

export const CreateMailboxReceiverRequest = z.object({
  mailbox_id: Ulid,
  domain_id: Ulid,
  priority: z.number().int().default(100),
  address_pattern: z.string().min(1).max(512),
  action: MailboxReceiverAction.default('webhook'),
  webhook_sub_id: Ulid.optional(),
  forward_to: Address.optional(),
});
export type CreateMailboxReceiverRequest = z.infer<typeof CreateMailboxReceiverRequest>;

// domain_id is sourced from the URL path (`/v1/admin/domains/:domainId/senders`)
// so the body schema doesn't require it. mailbox_id is sourced separately
// during the C-process pass.
export const CreateMailboxSenderRequest = z.object({
  domain_id: Ulid.optional(),
  local_part: z.string().regex(/^[a-z0-9._+-]{1,64}$/),
  display_name: z.string().min(1).max(120).optional(),
  default_for_mailbox: z.boolean().optional(),
});
export type CreateMailboxSenderRequest = z.infer<typeof CreateMailboxSenderRequest>;

// ---------- legacy compat aliases ----------
//
// Aliases preserved for the SQL strings + route paths that still ship under
// the legacy names. Keeping aliases keeps imports compiling; new code MUST
// use the mailbox-* names above.
export const CreateEmailSenderRequest = CreateMailboxSenderRequest;
export type CreateEmailSenderRequest = z.infer<typeof CreateEmailSenderRequest>;

export const CreateRoutingRuleRequest = z.object({
  domain_id: Ulid,
  priority: z.number().int().default(100),
  address_pattern: z.string().min(1).max(512),
  action: MailboxReceiverAction.default('webhook'),
  webhook_sub_id: Ulid.optional(),
  forward_to: Address.optional(),
});
export type CreateRoutingRuleRequest = z.infer<typeof CreateRoutingRuleRequest>;

export const CreateSmtpCredentialRequest = z.object({
  label: z.string().min(1).max(120).optional(),
});

// ---------- mail bridge ----------
//
// IMAP system flags are RFC 9051 §2.3.2 ("backslash"-prefixed identifiers).
// Custom keywords are any bare-string label the client stores. Polaris does
// not ship `\Draft` (INBOX-only model — no folder dimension).
export const SystemFlag = z.enum(['\\Seen', '\\Answered', '\\Flagged', '\\Deleted']);
export type SystemFlag = z.infer<typeof SystemFlag>;

// A MessageFlag is either a system flag or a custom keyword (any non-empty
// string up to 64 chars, no whitespace — matches IMAP atom rules loosely).
export const MessageFlag = z.union([
  SystemFlag,
  z
    .string()
    .min(1)
    .max(64)
    .regex(/^[^\s\\][^\s]*$/u, 'custom keyword: no whitespace, no leading backslash'),
]);
export type MessageFlag = z.infer<typeof MessageFlag>;

// `jmap` was removed in C1 / B6 (read-once secrets migration drops the
// bearer-token rows + column). Only the IMAP and SMTPS protocols remain.
export const MailBridgeProtocol = z.enum(['imap', 'smtps']);
export type MailBridgeProtocol = z.infer<typeof MailBridgeProtocol>;

// `bearer_token` was dropped with JMAP (C1 / B6); password is the only
// surviving auth type for mailbox credentials.
export const MailBridgeAuthType = z.enum(['password']);
export type MailBridgeAuthType = z.infer<typeof MailBridgeAuthType>;

// MailboxCredential — internal (D1) shape, see migration 0002 + 0005. The
// plaintext password is returned by the issue / rotate routes exactly once
// and NEVER persists outside the response. Public GET responses use
// `MailboxCredentialMetadata`.
export const MailboxCredential = z.object({
  id: Ulid,
  mailbox_id: Ulid,
  protocol: MailBridgeProtocol,
  auth_type: MailBridgeAuthType,
  username: z.string().min(1).max(254),
  // bcrypt hash is opaque to consumers; surfaced for bridge credential
  // lookup (which authenticates over admin HMAC). Plaintext-free.
  bcrypt_hash: z.string(),
  created_at: z.string(),
  last_used_at: z.string().nullable().optional(),
  disabled_at: z.string().nullable().optional(),
});
export type MailboxCredential = z.infer<typeof MailboxCredential>;

// Public GET response shape for /v1/admin/mailboxes/:id/credentials. Strips
// the stored hash entirely. Per A11.
export const MailboxCredentialMetadata = z.object({
  id: Ulid,
  mailbox_id: Ulid,
  protocol: MailBridgeProtocol,
  auth_type: MailBridgeAuthType,
  username: z.string().min(1).max(254),
  created_at: z.string(),
  last_used_at: z.string().nullable().optional(),
  disabled_at: z.string().nullable().optional(),
});
export type MailboxCredentialMetadata = z.infer<typeof MailboxCredentialMetadata>;

// One-shot response for POST /v1/admin/mailboxes/:id/credentials and
// POST /.../credentials/:credId/rotate. Plaintext shown ONCE.
export const MailboxCredentialCreatedResponse = z.object({
  id: Ulid,
  mailbox_id: Ulid.optional(),
  protocol: MailBridgeProtocol.optional(),
  auth_type: MailBridgeAuthType.optional(),
  plaintext: z.string(),
});
export type MailboxCredentialCreatedResponse = z.infer<typeof MailboxCredentialCreatedResponse>;

// MailboxMessageState: one row per (mailbox_id, message_id) in
// `mailbox_messages_state` (see migration 0002). `uid` + `uid_validity` drive
// IMAP UID semantics; `change_id` drives IMAP CONDSTORE MODSEQ.
export const MailboxMessageState = z.object({
  message_id: Ulid,
  mailbox_id: Ulid,
  read_at: z.string().nullable().optional(),
  expunged_at: z.string().nullable().optional(),
  flags: z.array(MessageFlag),
  uid: z.number().int().nonnegative(),
  uid_validity: z.number().int().nonnegative(),
  change_id: z.number().int().nonnegative(),
});
export type MailboxMessageState = z.infer<typeof MailboxMessageState>;

// ---------- Suppressions ----------
//
// Mirrors the CHECK enums on `suppressions` in
// `services/api/migrations/0010_suppressions.sql`.
export const SuppressionEntityType = z.enum(['recipient', 'sender']);
export type SuppressionEntityType = z.infer<typeof SuppressionEntityType>;

export const SuppressionScope = z.enum(['global', 'domain', 'mailbox', 'sender_address']);
export type SuppressionScope = z.infer<typeof SuppressionScope>;

export const SuppressionReason = z.enum([
  'hard_bounce',
  'spam_complaint',
  'unsubscribe',
  'manual',
  'arf_complaint',
  'phishing_report',
  'sender_abuse_threshold',
  'role_account',
  'invalid',
]);
export type SuppressionReason = z.infer<typeof SuppressionReason>;

export const SuppressionSource = z.enum([
  'cf_email_service',
  'arf_inbox',
  'one_click',
  'cli',
  'panel',
  'import',
  'sender_threshold_cron',
  'llm_triage',
]);
export type SuppressionSource = z.infer<typeof SuppressionSource>;

export const SuppressionSeverity = z.enum(['info', 'warn', 'critical']);
export type SuppressionSeverity = z.infer<typeof SuppressionSeverity>;

export const SuppressionRow = z.object({
  id: Ulid,
  entity_type: SuppressionEntityType,
  address_normalized: z.string(),
  address_local: z.string().nullable(),
  address_domain: z.string().nullable(),
  scope: SuppressionScope,
  scope_target: z.string().nullable(),
  reason: SuppressionReason,
  source: SuppressionSource,
  source_ref: z.string().nullable(),
  severity: SuppressionSeverity,
  created_at: z.string(),
  expires_at: z.string().nullable(),
  disabled_at: z.string().nullable(),
  disabled_reason: z.string().nullable(),
  notes: z.string().nullable(),
});
export type SuppressionRow = z.infer<typeof SuppressionRow>;

export const CreateSuppressionRequest = z.object({
  entity_type: SuppressionEntityType,
  address: z.string().min(3).max(320),
  scope: SuppressionScope.default('global'),
  scope_target: z.string().max(64).nullable().optional(),
  reason: SuppressionReason,
  source: SuppressionSource.default('panel'),
  severity: SuppressionSeverity.default('warn'),
  expires_at: z.string().datetime().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export type CreateSuppressionRequest = z.infer<typeof CreateSuppressionRequest>;

export const UpdateSuppressionRequest = z.object({
  notes: z.string().max(2000).nullable().optional(),
  expires_at: z.string().datetime().nullable().optional(),
});
export type UpdateSuppressionRequest = z.infer<typeof UpdateSuppressionRequest>;
