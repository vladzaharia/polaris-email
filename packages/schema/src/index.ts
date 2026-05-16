// Shared zod schemas + TypeScript types for polaris-email.
//
// Mailbox-centric model. Tenant / environment / forensic / routing-rule
// types are gone; mailbox, sender, and receiver shapes replace them. See
// `services/api/migrations/0001_init.sql` for the canonical D1 schema.
import { z } from 'zod';
import { TRANSPORT_FORBIDDEN_HEADERS } from '@polaris-email/mime';

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
// The set is the union of:
//   1. The transport-security set from `@polaris-email/mime`
//      (`TRANSPORT_FORBIDDEN_HEADERS`) — Received, DKIM-Signature,
//      Authentication-Results, ARC-*, Resent-*, Return-Path. These are
//      relay/MTA-owned and the canonicalizer rejects them on raw RFC822 too.
//   2. The "we generate this from a dedicated JSON field" set — Date,
//      Message-ID, From, To, Cc, Bcc, Subject, Content-Type, MIME-Version.
//      Setting these via the JSON `headers` map is meaningless because
//      `composeFromJson()` always writes them from the structured fields.
// All lowercase.
const SCHEMA_GENERATED_HEADERS = [
  'date',
  'message-id',
  'from',
  'to',
  'cc',
  'bcc',
  'subject',
  'content-type',
  'mime-version',
] as const;
export const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  ...TRANSPORT_FORBIDDEN_HEADERS,
  ...SCHEMA_GENERATED_HEADERS,
]);

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
});

// ---------- credential plane ----------

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
  // domain `r2.mail.plrs.im` (B5). Absolute, no expiry. Always populated for
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
  })
  .refine(
    (req) => {
      if (!req.headers) return true;
      for (const key of Object.keys(req.headers)) {
        if (FORBIDDEN_HEADERS.has(key.toLowerCase())) return false;
      }
      return true;
    },
    { message: 'forbidden header in headers' },
  );
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
  // mailbox CRUD
  'mailbox.create',
  'mailbox.update',
  'mailbox.disable',
  'mailbox.delete',
  // mailbox bridge ops (Phase L)
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
  // unified mailbox credentials (Phase L)
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
  // messages (submit/receive/lifecycle)
  'message.submitted',
  'message.received',
  'message.marked_read',
  'message.expunged',
  // rate limiting
  'rate_limit.exceeded',
  // CF zone discover + configure (cf-zones.ts)
  'cf_zone.configure',
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

// ---------- mail bridge (Phase L) ----------
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
