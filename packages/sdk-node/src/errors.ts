// `@polaris/sdk` — typed error model.
//
// Wire shape (per docs/errors.md):
//   { "error": { "code": "...", "message": "...", "retryable": bool, "request_id": "..." } }
//
// On non-2xx responses the SDK parses the envelope and throws `PolarisError`.
// If the body is not parseable (e.g. a CF/edge 502 HTML page), the SDK still
// throws a `PolarisError` with `code: "unknown"`, `retryable: status >= 500`,
// and `requestId` drawn from the `X-Request-Id` response header (or null when
// absent).
//
// `code` is left as a free `string` rather than a literal union because the
// API documents new codes as additive (CONSUMER-CONTRACT.md: "existing codes
// never change meaning"). Callers should still switch on the known values
// from `docs/errors.md`.

export class PolarisError extends Error {
  /** The stable error code, e.g. `"rate_limited"`. `"unknown"` on parse failure. */
  readonly code: string;
  /** The HTTP status code. */
  readonly status: number;
  /**
   * Whether the API marked this error retryable. Callers should retry only
   * when `retryable === true`, per CONSUMER-CONTRACT.md.
   */
  readonly retryable: boolean;
  /** The `X-Request-Id` correlation id (or envelope `request_id`); `null` when neither is present. */
  readonly requestId: string | null;

  constructor(
    message: string,
    code: string,
    status: number,
    retryable: boolean,
    requestId: string | null,
  ) {
    super(message);
    this.name = 'PolarisError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.requestId = requestId;
    // Preserve prototype chain when extending built-ins under older TS targets.
    Object.setPrototypeOf(this, PolarisError.prototype);
  }
}

/** Type predicate. Use this in `catch` blocks for programmatic dispatch. */
export function isPolarisError(e: unknown): e is PolarisError {
  return e instanceof PolarisError;
}

/**
 * Convenience: `true` when an error is safe to retry per
 * CONSUMER-CONTRACT.md. Non-`PolarisError` values return `false` — the SDK
 * does not assume transport-level errors (fetch rejection) are retryable
 * because retry-safety depends on whether the request was idempotent.
 */
export function isRetryable(e: unknown): boolean {
  return isPolarisError(e) && e.retryable;
}

interface RawEnvelope {
  error?: {
    code?: unknown;
    message?: unknown;
    retryable?: unknown;
    request_id?: unknown;
  };
}

/**
 * Build a `PolarisError` from a non-2xx HTTP response. The body may be the
 * raw text, an already-parsed JSON object, or `null`. Headers may be a
 * `Headers` instance, a plain record, or `null`.
 *
 * Exported so callers writing their own transport (or post-processing
 * `Polaris.call` results) can produce identically-shaped errors.
 */
export function parsePolarisError(
  status: number,
  body: unknown,
  headers: Headers | Record<string, string | string[] | undefined> | null,
): PolarisError {
  const headerRequestId = pickHeader(headers, 'x-request-id');

  let parsed: RawEnvelope | null = null;
  if (body && typeof body === 'object') {
    parsed = body as RawEnvelope;
  } else if (typeof body === 'string' && body.length > 0) {
    try {
      parsed = JSON.parse(body) as RawEnvelope;
    } catch {
      parsed = null;
    }
  }

  const env = parsed?.error;
  if (env && typeof env.code === 'string' && env.code.length > 0) {
    const code = env.code;
    const message = typeof env.message === 'string' ? env.message : code;
    const retryable = typeof env.retryable === 'boolean' ? env.retryable : status >= 500;
    const envelopeRequestId =
      typeof env.request_id === 'string' && env.request_id.length > 0 ? env.request_id : null;
    return new PolarisError(
      message,
      code,
      status,
      retryable,
      envelopeRequestId ?? headerRequestId,
    );
  }

  // No parseable envelope — fall back to status-derived defaults.
  const fallbackMessage =
    typeof body === 'string' && body.length > 0
      ? `HTTP ${status}: ${body.slice(0, 200)}`
      : `HTTP ${status}`;
  return new PolarisError(fallbackMessage, 'unknown', status, status >= 500, headerRequestId);
}

function pickHeader(
  h: Headers | Record<string, string | string[] | undefined> | null,
  name: string,
): string | null {
  if (h == null) return null;
  if (typeof Headers !== 'undefined' && h instanceof Headers) {
    return h.get(name);
  }
  const lower = name.toLowerCase();
  const key = Object.keys(h).find((k) => k.toLowerCase() === lower);
  if (!key) return null;
  const v = (h as Record<string, string | string[] | undefined>)[key];
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}
