// Shared zod schemas + TypeScript types for polaris-email.
import { z } from 'zod';

// ---------- primitives ----------

export const Ulid = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'invalid ulid');
export const ServiceSlug = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const RuleSlug = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const Address = z
  .string()
  .email()
  .max(320);
export const DomainName = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/);
export const HostHeader = z.string().regex(/^[A-Za-z0-9._-]+$/);

// ---------- scope types ----------

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

export const KeyScope = z.enum(['send', 'admin:rotate', 'admin:read', 'forensic:request']);
export const KeyScopes = z.array(KeyScope).min(1);

// ---------- message I/O ----------

export const Attachment = z.object({
  filename: z.string().max(255),
  contentType: z.string().max(127),
  contentB64: z.string().max(25 * 1024 * 1024), // raw size cap upstream
});

export const SendMessageRequest = z.object({
  from: Address,
  to: z.array(Address).min(1).max(50),
  cc: z.array(Address).max(50).optional(),
  bcc: z.array(Address).max(50).optional(),
  replyTo: Address.optional(),
  subject: z.string().max(998),
  html: z.string().max(5 * 1024 * 1024).optional(),
  text: z.string().max(5 * 1024 * 1024).optional(),
  headers: z.record(z.string().max(998), z.string().max(998)).optional(),
  attachments: z.array(Attachment).max(20).optional(),
  category: z.string().regex(/^[a-z0-9.-]{1,64}$/),
  mode: z.enum(['live', 'test']).default('live'),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

export const SendMessageResponse = z.object({
  messageId: Ulid,
  queuedAt: z.number().int().nonnegative(),
  mode: z.enum(['live', 'test']),
});
export type SendMessageResponse = z.infer<typeof SendMessageResponse>;

// ---------- error envelope ----------

export const ErrorCode = z.enum([
  'bad_request',
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

export const WebhookEventType = z.enum([
  'message.received',
  'message.bounced',
  'message.sent',
  'message.delivered',
  'message.failed',
  'credential.rotated',
  'credential.revoked',
]);
export type WebhookEventType = z.infer<typeof WebhookEventType>;

export const WebhookEnvelope = z.object({
  event_id: Ulid,
  event: WebhookEventType,
  created_at: z.number().int().nonnegative(),
  data: z.unknown(),
});
export type WebhookEnvelope = z.infer<typeof WebhookEnvelope>;

// ---------- domain model (D1 row shapes; not the public REST surface) ----------

export const Service = z.object({
  id: ServiceSlug,
  name: z.string().min(1).max(120),
  owner: z.string().email().nullable(),
  notes: z.string().max(2000).nullable(),
  created_at: z.number().int(),
  disabled_at: z.number().int().nullable(),
});

export const Domain = z.object({
  name: DomainName,
  direction: z.enum(['in', 'out', 'both']),
  binding_name: z.string().nullable(),
  dns_records_json: z.string().nullable(),
  verified_at: z.number().int().nullable(),
  last_verify_check_at: z.number().int().nullable(),
  disabled_at: z.number().int().nullable(),
});

export const Mailbox = z.object({
  id: Ulid,
  address: Address,
  display_name: z.string().nullable(),
  service_id: ServiceSlug.nullable(),
  imap_username: z.string().nullable(),
  imap_pw_bcrypt: z.string().nullable(),
  imap_pw_bcrypt_prev: z.string().nullable(),
  imap_pw_rotated_at: z.number().int().nullable(),
  retain_imap: z.number().int().min(0).max(1),
  retention_days: z.number().int().positive(),
  max_inbound_bytes: z.number().int().positive(),
  created_at: z.number().int(),
  disabled_at: z.number().int().nullable(),
});

export const ApiKey = z.object({
  id: Ulid,
  prefix: z.string(),
  secret_argon2id: z.string(),
  service_id: ServiceSlug.nullable(),
  sender_scopes: z.string(), // JSON array of SenderScope
  scopes: z.string(), // JSON array of KeyScope
  rate_limit_per_min: z.number().int().positive(),
  status: z.enum(['primary', 'secondary', 'revoked']),
  created_at: z.number().int(),
  revoked_at: z.number().int().nullable(),
  last_used_at: z.number().int().nullable(),
  last_used_ip: z.string().nullable(),
  last_used_ua: z.string().nullable(),
});

export const WebhookSub = z.object({
  id: Ulid,
  mailbox_id: Ulid.nullable(),
  service_id: ServiceSlug.nullable(),
  url: z.string().url(),
  kind: z.enum(['external', 'tailnet', 'bridge']),
  local_target_id: Ulid.nullable(),
  secret: z.string(),
  secret_prev: z.string().nullable(),
  events: z.string(), // JSON array of WebhookEventType
  paused_at: z.number().int().nullable(),
});

export const RoutingRule = z.object({
  id: Ulid,
  domain: DomainName,
  match_json: z.string(),
  mailbox_id: Ulid,
  priority: z.number().int(),
  created_at: z.number().int(),
});

export const LocalWebhookTarget = z.object({
  id: Ulid,
  service_id: ServiceSlug.nullable(),
  service: ServiceSlug,
  rule: RuleSlug,
  upstream: z.string().url(),
  created_at: z.number().int(),
  disabled_at: z.number().int().nullable(),
});

export const MessageRow = z.object({
  id: Ulid,
  mailbox_id: Ulid.nullable(),
  service_id: ServiceSlug.nullable(),
  direction: z.enum(['in', 'out']),
  mode: z.enum(['live', 'test']),
  status: z.enum([
    'queued',
    'sent',
    'delivered',
    'bounced',
    'failed',
    'received',
    'parse_failed',
  ]),
  from_addr: z.string().nullable(),
  to_hash: z.string().nullable(),
  to_forensic_encrypted: z.string().nullable(),
  subject: z.string().nullable(),
  size_bytes: z.number().int().nonnegative(),
  r2_key: z.string().nullable(),
  category: z.string().nullable(),
  idempotency_key: z.string().nullable(),
  imap_uid: z.number().int().nullable(),
  imap_uidvalidity: z.number().int().nullable(),
  delivered_to_imap_at: z.number().int().nullable(),
  last_error: z.string().nullable(),
  smtp_response: z.string().nullable(),
  auth_results_json: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

export const MessageDelivery = z.object({
  message_id: Ulid,
  sub_id: Ulid,
  status: z.enum(['pending', 'succeeded', 'failed', 'dlq']),
  attempts: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  last_response_code: z.number().int().nullable(),
  next_attempt_at: z.number().int().nullable(),
  succeeded_at: z.number().int().nullable(),
  failed_at: z.number().int().nullable(),
});

export const AuditAction = z.enum([
  'api_key.issue',
  'api_key.rotate',
  'api_key.rotate.emergency',
  'api_key.revoke',
  'api_key.revoke.emergency',
  'mailbox.create',
  'mailbox.update',
  'mailbox.disable',
  'mailbox.password_rotate',
  'mailbox.password_rotate.emergency',
  'domain.register',
  'domain.verify',
  'domain.dns_record_change',
  'domain.disable',
  'domain.dkim_rotate',
  'webhook_sub.create',
  'webhook_sub.update',
  'webhook_sub.delete',
  'webhook_sub.pause',
  'webhook_sub.test_fire',
  'webhook_sub.replay',
  'routing_rule.create',
  'routing_rule.update',
  'routing_rule.delete',
  'local_webhook_target.create',
  'local_webhook_target.update',
  'local_webhook_target.delete',
  'bridge.reload',
  'service.create',
  'service.update',
  'service.disable',
  'service.quarantine',
  'forensic_decrypt',
  'dry_run_rotate',
  'panel.login',
  'panel.login_failure',
  'panel.logout',
  'panel.session_create',
  'panel.step_up',
  'schema.migration',
  'bootstrap.consume',
]);
export type AuditAction = z.infer<typeof AuditAction>;

export const AuditRow = z.object({
  id: z.number().int(),
  actor: z.string(),
  action: AuditAction,
  target: z.string().nullable(),
  meta_json: z.string(),
  prev_hash: z.string(),
  row_hash: z.string(),
  at: z.number().int(),
});

// ---------- admin REST shapes ----------

export const IssueApiKeyRequest = z.object({
  service_id: ServiceSlug,
  sender_scopes: z.array(SenderScope).min(1),
  scopes: KeyScopes.default(['send']),
  rate_limit_per_min: z.number().int().positive().max(100000).default(1000),
});

export const RotateRequest = z.object({
  mode: z.enum(['planned', 'emergency']),
  reason: z.string().max(500).optional(),
  new_label: z.string().max(120).optional(),
});

export const CreateMailboxRequest = z.object({
  address: Address,
  display_name: z.string().min(1).max(120).optional(),
  service_id: ServiceSlug.optional(),
  retain_imap: z.boolean().default(false),
  retention_days: z.number().int().positive().max(3650).default(90),
  max_inbound_bytes: z
    .number()
    .int()
    .positive()
    .max(25 * 1024 * 1024)
    .default(25 * 1024 * 1024),
});

export const CreateWebhookSubRequest = z.object({
  mailbox_id: Ulid.optional(),
  service_id: ServiceSlug.optional(),
  url: z.string().url(),
  kind: z.enum(['external', 'tailnet', 'bridge']),
  local_target_id: Ulid.optional(),
  events: z.array(WebhookEventType).min(1),
});

export const CreateRoutingRuleRequest = z.object({
  domain: DomainName,
  mailbox_id: Ulid,
  priority: z.number().int().default(100),
  match: z
    .object({
      to_regex: z.string().max(512).optional(),
      from_regex: z.string().max(512).optional(),
      subject_regex: z.string().max(512).optional(),
    })
    .default({}),
});

export const CreateLocalTargetRequest = z.object({
  service: ServiceSlug,
  rule: RuleSlug,
  upstream: z.string().url(),
});

export const CreateServiceRequest = z.object({
  id: ServiceSlug,
  name: z.string().min(1).max(120),
  owner: z.string().email().optional(),
  notes: z.string().max(2000).optional(),
});

export const BulkRevokeServiceRequest = z.object({
  service_id: ServiceSlug,
  mode: z.literal('emergency'),
  incident_ticket_id: z.string().min(1).max(120),
  confirmation: ServiceSlug, // must equal service_id
});

// ---------- panel forensic decrypt ----------

export const ForensicDecryptRequest = z.object({
  message_id: Ulid,
  incident_ticket_id: z.string().min(1).max(120),
  approver_subject: z.string().min(1).max(256), // second OIDC subject
});

// ---------- bridge config (sidecar fetches this) ----------

export const BridgeMailboxConfig = z.object({
  id: Ulid,
  address: Address,
  imap_username: z.string(),
  imap_pw_bcrypt: z.string(),
  imap_pw_bcrypt_prev: z.string().nullable(),
  retain_imap: z.boolean(),
  smtp_sender_scopes: z.array(SenderScope),
  api_key_id: Ulid, // per-mailbox bridge key for SMTPS→REST
  api_key_secret: z.string(),
});

export const BridgeConfig = z.object({
  mailboxes: z.array(BridgeMailboxConfig),
  local_webhook_targets: z.array(
    z.object({
      service: ServiceSlug,
      rule: RuleSlug,
      upstream: z.string().url(),
    }),
  ),
  rate_limits: z.object({
    inbound_per_mailbox_per_min: z.number().int().nonnegative().default(120),
    inbound_per_source_ip_per_min: z.number().int().nonnegative().default(60),
  }),
});
export type BridgeConfig = z.infer<typeof BridgeConfig>;
