// `@polaris/sdk` — TypeScript SDK for polaris-email.
//
// Re-exports the generated type surface plus a hand-written `Polaris` client
// with HMAC + service-binding auth pluggable via `authBuilder`. Sub-paths:
//   - `@polaris/sdk/webhook` — verifyWebhook (un-versioned HMAC)
//   - `@polaris/sdk/react`   — TanStack Query hooks (generated)
//   - `@polaris/sdk/node`    — Node-only helpers (streams, file uploads)
//
// Error model (G1): non-2xx responses throw `PolarisError` with `.code`,
// `.status`, `.retryable`, and `.requestId`. Callers honor
// `CONSUMER-CONTRACT.md` retry rules by checking `err.retryable`.
export * from './generated/index.js';
import type {
  Mailbox,
  Message,
  MessageList,
  SendRequest,
  SendResponse,
} from './generated/index.js';
import { parsePolarisError } from './errors.js';

export interface PolarisRequest {
  method: string;
  path: string;
  query?: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

export type AuthBuilder = (req: PolarisRequest) => Promise<Record<string, string>> | Record<
  string,
  string
>;

export interface PolarisOptions {
  baseUrl: string;
  /**
   * Returns the auth-related headers to splice in (e.g. X-Polaris-Sig + key id,
   * or a service-binding token). Called per request after `req.body` is
   * finalized so HMAC implementations can hash the body.
   */
  authBuilder?: AuthBuilder;
  /** Custom fetch implementation (defaults to global fetch). */
  fetch?: typeof fetch;
  /** Default `application/json`. */
  defaultContentType?: string;
}

export interface PolarisResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

export class Polaris {
  readonly baseUrl: string;
  private readonly authBuilder?: AuthBuilder;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultCT: string;

  constructor(opts: PolarisOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.authBuilder = opts.authBuilder;
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as typeof fetch);
    this.defaultCT = opts.defaultContentType ?? 'application/json';
  }

  /**
   * Low-level call. Most callers want one of the typed helpers below; this is
   * exposed for routes that haven't grown a typed wrapper yet.
   */
  async call<T = unknown>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      query?: string;
      contentType?: string;
      extraHeaders?: Record<string, string>;
    } = {},
  ): Promise<PolarisResponse<T>> {
    const contentType = options.contentType ?? this.defaultCT;
    let bodyBytes: Uint8Array | null;
    if (options.body == null) {
      bodyBytes = null;
    } else if (options.body instanceof Uint8Array) {
      bodyBytes = options.body;
    } else if (typeof options.body === 'string') {
      bodyBytes = new TextEncoder().encode(options.body);
    } else {
      bodyBytes = new TextEncoder().encode(JSON.stringify(options.body));
    }
    const headers: Record<string, string> = {
      'content-type': contentType,
      ...(options.extraHeaders ?? {}),
    };
    const req: PolarisRequest = {
      method,
      path,
      query: options.query,
      headers,
      body: bodyBytes,
    };
    if (this.authBuilder) {
      const authHeaders = await this.authBuilder(req);
      for (const [k, v] of Object.entries(authHeaders)) headers[k.toLowerCase()] = v;
    }
    const url =
      this.baseUrl + path + (options.query ? '?' + options.query.replace(/^\?/, '') : '');
    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : (bodyBytes ?? undefined),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON; leave as text
    }
    if (!res.ok) {
      // Non-2xx: surface a typed PolarisError. parsePolarisError handles
      // both well-formed `{ error: { ... } }` envelopes and unparseable
      // bodies (e.g. a CF 502 HTML page), so callers always see the same
      // shape.
      throw parsePolarisError(res.status, parsed ?? text, res.headers);
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  // ---------- typed helpers (subset) ----------

  async sendMessage(
    req: SendRequest,
    extra?: { idempotencyKey?: string },
  ): Promise<PolarisResponse<SendResponse>> {
    const extraHeaders: Record<string, string> = {};
    if (extra?.idempotencyKey) extraHeaders['idempotency-key'] = extra.idempotencyKey;
    return this.call<SendResponse>('POST', '/v1/messages', { body: req, extraHeaders });
  }

  async sendRfc822(
    bytes: Uint8Array,
    extraHeaders: Record<string, string>,
  ): Promise<PolarisResponse<SendResponse>> {
    return this.call<SendResponse>('POST', '/v1/messages', {
      body: bytes,
      contentType: 'message/rfc822',
      extraHeaders,
    });
  }

  async listMessages(query?: string): Promise<PolarisResponse<MessageList>> {
    return this.call<MessageList>('GET', '/v1/messages', { query });
  }

  async getMessage(id: string): Promise<PolarisResponse<Message>> {
    return this.call<Message>('GET', `/v1/messages/${id}`);
  }

  async listMailboxes(): Promise<PolarisResponse<{ data: Mailbox[] }>> {
    return this.call('GET', '/v1/admin/mailboxes');
  }
}

export { verifyWebhook } from './webhook.js';
export type { VerifyResult, VerifyWebhookInput } from './webhook.js';
export { PolarisError, isPolarisError, isRetryable, parsePolarisError } from './errors.js';
