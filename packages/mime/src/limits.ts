/**
 * Canonical CF Email Service limits (snapshot 2026-05-15).
 *
 * Pure constants module mirroring Cloudflare Email Service's published header
 * and limit rules. All set members are lowercase to enable case-insensitive
 * comparisons against canonicalized header names.
 *
 * IMPORTANT: Changing any value or set membership in this file is a behavioral
 * change. Updates here MUST be paired with corresponding updates to:
 *   - public docs describing limits / accepted headers
 *   - openapi.yaml (and any drift test)
 *   - error-code tables that reference these limits
 */

export const MAX_RECIPIENTS = 50;
export const MAX_SUBJECT_LENGTH = 998;
export const MAX_MESSAGE_SIZE_VERIFIED = 25 * 1024 * 1024;
export const MAX_MESSAGE_SIZE_UNVERIFIED = 5 * 1024 * 1024;
export const MAX_CUSTOM_HEADERS_PAYLOAD = 16 * 1024;
export const MAX_NON_X_CUSTOM_HEADERS = 20;
export const MAX_HEADER_NAME_LENGTH = 100;
export const MAX_HEADER_VALUE_LENGTH = 2048;

export const WHITELISTED_CUSTOM_HEADERS: ReadonlySet<string> = new Set([
  'in-reply-to',
  'references',
  'list-unsubscribe',
  'list-unsubscribe-post',
  'list-id',
  'list-archive',
  'list-help',
  'list-owner',
  'list-post',
  'list-subscribe',
  'precedence',
  'auto-submitted',
  'content-language',
  'keywords',
  'comments',
  'importance',
  'sensitivity',
  'organization',
  'require-recipient-valid-since',
  'archived-at',
]);

export const PLATFORM_CONTROLLED_HEADERS: ReadonlySet<string> = new Set([
  'date',
  'message-id',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
  'dkim-signature',
  'return-path',
  'received',
  'feedback-id',
  'arc-seal',
  'arc-message-signature',
  'arc-authentication-results',
  'tls-required',
  'tls-report-domain',
  'tls-report-submitter',
  'cfbl-address',
  'cfbl-feedback-id',
]);

export const USE_API_FIELD_HEADERS: ReadonlySet<string> = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'subject',
  'reply-to',
]);
