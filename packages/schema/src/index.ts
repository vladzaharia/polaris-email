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

export const Tenant = z.object({
  id: Ulid,
  name: z.string().min(1).max(120),
  description: z.string().nullable(),
  environment: z.string(),
  to_hash_pepper_id: z.string().nullable(),
  pepper_version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  disabled_at: z.string().nullable(),
});
export type Tenant = z.infer<typeof Tenant>;

export const MailDomain = z.object({
  id: Ulid,
  zone_id: Ulid,
  parent_domain_id: Ulid.nullable(),
  name: DomainName,
  environment: z.string(),
  status: z.string(),
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

export const ApiKey = z.object({
  id: Ulid,
  principal_id: Ulid,
  prefix: z.string(),
  secret_argon2id: z.string(),
  sender_scopes: z.string().nullable(),
  scopes: z.string(),
  rate_limit_per_min: z.number().int().positive(),
  status: z.enum(['primary', 'secondary', 'revoked']),
  created_at: z.string(),
  revoked_at: z.string().nullable(),
  last_used_at: z.string().nullable(),
  last_used_ip: z.string().nullable(),
  last_used_ua: z.string().nullable(),
});

export const WebhookSub = z.object({
  id: Ulid,
  tenant_id: Ulid,
  domain_id: Ulid.nullable(),
  route_id: z.string().nullable(),
  url: z.string().url(),
  kind: z.enum(['external', 'tailnet']),
  secret: z.string(),
  secret_prev: z.string().nullable(),
  events: z.string(), // JSON array of WebhookEventType
  paused_at: z.string().nullable(),
  environment: z.string(),
  created_at: z.string(),
  disabled_at: z.string().nullable(),
});

export const RoutingRule = z.object({
  id: Ulid,
  domain_id: Ulid,
  priority: z.number().int(),
  address_pattern: z.string(),
  action: z.enum(['webhook', 'forward', 'drop', 'alias']),
  webhook_sub_id: Ulid.nullable(),
  forward_to: z.string().nullable(),
  environment: z.string(),
  enabled: z.number().int(),
  created_at: z.string(),
  disabled_at: z.string().nullable(),
});

export const MessageRow = z.object({
  id: Ulid,
  tenant_id: Ulid,
  principal_id: Ulid.nullable(),
  daemon_id: Ulid.nullable(),
  submission_id: Ulid.nullable(),
  direction: z.enum(['in', 'out']),
  status: z.enum(['received', 'mime_stored', 'queued', 'sending', 'sent', 'failed', 'bounced']),
  send_attempt_id: z.string().nullable(),
  from_addr: z.string().nullable(),
  to_hash_pending: z.number().int(),
  subject: z.string().nullable(),
  r2_key: z.string(),
  content_sha256: z.string().nullable(),
  idempotency_key: z.string().nullable(),
  environment: z.string(),
  received_at_daemon: z.string().nullable(),
  received_at_api: z.string().nullable(),
  queued_at: z.string().nullable(),
  sending_at: z.string().nullable(),
  sent_at: z.string().nullable(),
  failed_at: z.string().nullable(),
  bounce_metadata: z.string().nullable(),
  last_error: z.string().nullable(),
  created_at: z.string(),
});

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

// ---------- outbound domains + senders + SMTP credentials ----------

export const OutboundDomainStatus = z.enum(['pending', 'verified', 'active', 'disabled']);
export type OutboundDomainStatus = z.infer<typeof OutboundDomainStatus>;

export const DmarcPolicy = z.enum(['none', 'quarantine', 'reject']);

export const OutboundDomain = z.object({
  id: Ulid,
  domain: DomainName,
  dkim_selector: z.string().min(1).max(63),
  status: OutboundDomainStatus,
  cf_zone_id: z.string().nullable(),
  is_default: z.number().int().min(0).max(1),
  dmarc_policy: DmarcPolicy,
  dmarc_rua: z.string().nullable(),
  binding_tag: z.string().nullable(),
  last_verified_at: z.number().int().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  disabled_at: z.number().int().nullable(),
});
export type OutboundDomain = z.infer<typeof OutboundDomain>;

export const CreateOutboundDomainRequest = z.object({
  domain: DomainName,
  dkim_selector: z.string().min(1).max(63).optional(),
  is_default: z.boolean().optional(),
  dmarc_policy: DmarcPolicy.optional(),
  dmarc_rua: z.string().max(320).optional(),
  binding_tag: z.string().regex(/^[A-Z][A-Z0-9_]{0,62}$/).optional(),
});

export const UpdateOutboundDomainRequest = z.object({
  cf_zone_id: z.string().max(64).optional(),
  status: OutboundDomainStatus.optional(),
  is_default: z.boolean().optional(),
  dmarc_policy: DmarcPolicy.optional(),
  dmarc_rua: z.string().max(320).optional(),
  binding_tag: z.string().regex(/^[A-Z][A-Z0-9_]{0,62}$/).optional(),
  dkim_selector: z.string().min(1).max(63).optional(),
});

export const EmailSender = z.object({
  id: Ulid,
  domain_id: Ulid,
  local_part: z.string().regex(/^[a-z0-9._+-]{1,64}$/),
  display_name: z.string().nullable(),
  default_for_domain: z.number().int().min(0).max(1),
  created_at: z.number().int(),
  disabled_at: z.number().int().nullable(),
});
export type EmailSender = z.infer<typeof EmailSender>;

export const CreateEmailSenderRequest = z.object({
  local_part: z.string().regex(/^[a-z0-9._+-]{1,64}$/),
  display_name: z.string().min(1).max(120).optional(),
  default_for_domain: z.boolean().optional(),
});

export const CreateSmtpCredentialRequest = z.object({
  label: z.string().min(1).max(120).optional(),
});

export const SmtpCredential = z.object({
  id: Ulid,
  sender_id: Ulid,
  username: Address,
  label: z.string().nullable(),
  last_used_at: z.number().int().nullable(),
  disabled_at: z.number().int().nullable(),
  created_at: z.number().int(),
});
export type SmtpCredential = z.infer<typeof SmtpCredential>;

export const AuditAction = z.enum([
  'outbound_domain.create',
  'outbound_domain.update',
  'outbound_domain.verify',
  'outbound_domain.verify_incomplete',
  'outbound_domain.disable',
  'email_sender.create',
  'email_sender.disable',
  'smtp_credential.issue',
  'smtp_credential.disable',
  'api_key.issue',
  'api_key.rotate',
  'api_key.rotate.emergency',
  'api_key.revoke',
  'api_key.revoke.emergency',
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
  'forensic_decrypt',
  'dry_run_rotate',
  'panel.login',
  'panel.login_failure',
  'panel.logout',
  'panel.session_create',
  'panel.step_up',
  'schema.migration',
  'bootstrap.consume',
  // Phase 0: new pipeline events
  'message.submitted',
  'message.queued',
  'message.sent',
  'message.failed',
  'message.bounced',
  'tenant.create',
  'tenant.update',
  'tenant.disable',
  'tenant.rotate_pepper',
  'principal.create',
  'principal.revoke',
  'principal.rotate',
  'daemon.register',
  'daemon.deregister',
  'daemon.rotate',
  'zone.register',
  'dkim_key.create',
  'dkim_key.activate',
  'dkim_key.retire',
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

export const IssueApiKeyRequest = z.object({
  // Tenant id (canonical). The legacy `service_id` request field is kept on the
  // wire by clients and routed to `tenant_id` server-side; new callers should
  // send `tenant_id` directly.
  tenant_id: ServiceSlug.optional(),
  service_id: ServiceSlug.optional(),
  display_name: z.string().min(1).max(120).optional(),
  sender_scopes: z.array(SenderScope).min(1),
  scopes: KeyScopes.default(['send']),
  rate_limit_per_min: z.number().int().positive().max(100000).default(1000),
}).refine((o) => o.tenant_id || o.service_id, {
  message: 'tenant_id or service_id required',
});

export const RotateRequest = z.object({
  mode: z.enum(['planned', 'emergency']),
  reason: z.string().max(500).optional(),
  new_label: z.string().max(120).optional(),
});

export const CreateWebhookSubRequest = z.object({
  tenant_id: ServiceSlug.optional(),
  service_id: ServiceSlug.optional(),
  domain_id: Ulid.optional(),
  url: z.string().url(),
  kind: z.enum(['external', 'tailnet']),
  events: z.array(WebhookEventType).min(1),
}).refine((o) => o.tenant_id || o.service_id, {
  message: 'tenant_id or service_id required',
});

export const CreateRoutingRuleRequest = z.object({
  domain_id: Ulid,
  priority: z.number().int().default(100),
  address_pattern: z.string().min(1).max(512),
  action: z.enum(['webhook', 'forward', 'drop', 'alias']).default('webhook'),
  webhook_sub_id: Ulid.optional(),
  forward_to: Address.optional(),
});

export const CreateServiceRequest = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
});

export const BulkRevokeServiceRequest = z.object({
  service_id: z.string().min(1).max(64),
  mode: z.literal('emergency'),
  incident_ticket_id: z.string().min(1).max(120),
  confirmation: z.string().min(1).max(64),
});

// ---------- panel forensic decrypt ----------

export const ForensicDecryptRequest = z.object({
  message_id: Ulid,
  incident_ticket_id: z.string().min(1).max(120),
  approver_subject: z.string().min(1).max(256), // second OIDC subject
});
