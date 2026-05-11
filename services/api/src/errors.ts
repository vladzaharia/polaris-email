// Error envelope helper. Every non-2xx response goes through buildError().
import type { Context } from 'hono';
import type { ErrorCode } from '@polaris-email/schema';
import { requestId } from './ids.js';

export const ERROR_HTTP: Record<ErrorCode, number> = {
  bad_request: 400,
  bad_signature: 401,
  key_propagating: 401,
  clock_skew: 401,
  key_revoked: 403,
  scope_violation: 403,
  nonce_replay: 409,
  idempotency_conflict: 409,
  domain_not_verified: 422,
  recipient_rejected: 422,
  rate_limited: 429,
  cf_upstream: 502,
  degraded: 503,
  not_found: 404,
  unauthorized: 401,
  forbidden: 403,
  conflict: 409,
};

export const ERROR_RETRYABLE: Record<ErrorCode, boolean> = {
  bad_request: false,
  bad_signature: false,
  key_propagating: true,
  clock_skew: true,
  key_revoked: false,
  scope_violation: false,
  nonce_replay: false,
  idempotency_conflict: false,
  domain_not_verified: false,
  recipient_rejected: false,
  rate_limited: true,
  cf_upstream: true,
  degraded: true,
  not_found: false,
  unauthorized: false,
  forbidden: false,
  conflict: false,
};

export function buildError(
  c: Context,
  code: ErrorCode,
  message: string,
  extraHeaders: Record<string, string> = {},
): Response {
  const id = c.get('requestId') ?? requestId();
  const body = {
    error: { code, message, retryable: ERROR_RETRYABLE[code], request_id: id },
  };
  const headers = new Headers({ 'content-type': 'application/json', 'x-request-id': id });
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  return new Response(JSON.stringify(body), { status: ERROR_HTTP[code], headers });
}
