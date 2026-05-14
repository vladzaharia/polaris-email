// Shared zod schemas + TypeScript types for polaris-email.
//
// Mailbox-centric model. Tenant / environment / forensic / routing-rule
// types are gone; mailbox, sender, and receiver shapes replace them. See
// `services/api/migrations/0001_init.sql` for the canonical D1 schema.
import { z } from 'zod';

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
// Mirrors `packages/mime/src/canonicalize.ts` FORBIDDEN_HEADERS plus the
// "we generate this" set (Date / Message-ID / etc.). All lowercase.
export const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  'date',
  'message-id',
  'received',
  'from',
  'to',
  'cc',
  'bcc',
  'subject',
  'content-type',
  'mime-version',
  'dkim-signature',
  'authentication-results',
  'return-path',
  'arc-seal',
  'arc-message-signature',
  'arc-authentication-results',
  'resent-date',
  'resent-from',
  'resent-sender',
  'resent-to',
  'resent-cc',
  'resent-bcc',
  'resent-message-id',
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

export const SmtpCredential = z.object({
  id: Ulid,
  principal_id: Ulid,
  sender_id: Ulid,
  daemon_id: Ulid.nullable().optional(),
  username: Address,
  bcrypt_hash: z.string(),
  created_at: z.string(),
  last_used_at: z.string().nullable().optional(),
  disabled_at: z.string().nullable().optional(),
});
export type SmtpCredential = z.infer<typeof SmtpCredential>;

// ---------- webhook subs ----------

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
  // Exactly one of content_base64 or content_url is populated per
  // inline-small/url-large strategy decided at read time.
  content_base64: z.string().optional(),
  content_url: z.string().url().optional(),
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
  to: z.array(z.string()),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string().optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  attachments: z.array(MessageAttachment),
  header_message_id: z.string().optional(),
  thread_id: z.string().optional(),
  auth: MessageAuth.optional(),
  body_bytes: z.number().int().nonnegative().optional(),
  attachments_total_bytes: z.number().int().nonnegative().optional(),
  received_at_daemon: z.string().optional(),
  received_at_api: z.string().optional(),
  queued_at: z.string().optional(),
  sending_at: z.string().optional(),
  sent_at: z.string().optional(),
  delivered_at: z.string().optional(),
  failed_at: z.string().optional(),
  bounce_metadata: z.unknown().optional(),
  last_error: z.string().optional(),
  created_at: z.string(),
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
  'dry_run_rotate',
  // daemon lifecycle
  'daemon.register',
  'daemon.rotate',
  'daemon.deregister',
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
  // legacy tenant ops — accepted by the audit CHECK for historic-log replay
  // only. New code paths MUST NOT emit these.
  'tenant.create',
  'tenant.update',
  'tenant.disable',
  'tenant.rotate_pepper',
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

// Pre-mailbox bootstrap shapes kept until C-auth / C-routes pass. These were
// "tenant" in the old schema; map them to a slug-shaped admin payload so the
// admin route still compiles. New code MUST NOT use these.
export const CreateTenantRequest = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
});
export type CreateTenantRequest = z.infer<typeof CreateTenantRequest>;

export const BulkRevokeTenantRequest = z.object({
  tenant_id: z.string().min(1).max(64),
  mode: z.literal('emergency'),
  incident_ticket_id: z.string().min(1).max(120),
  confirmation: z.string().min(1).max(64),
});
export type BulkRevokeTenantRequest = z.infer<typeof BulkRevokeTenantRequest>;
