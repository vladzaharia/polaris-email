import type { ZodSchema } from 'zod';

export interface CloudflareApiClientOptions {
  apiToken: string;
  accountId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /**
   * 4a.10: cap on retries for 429/503 responses. Defaults to 3. Set to 0 to
   * disable. Each retry waits for `Retry-After` (when present) or an
   * exponential backoff (1s, 2s, 4s) capped at 8s.
   */
  maxRetries?: number;
  /**
   * Test injection for the sleep used between retries. Defaults to a real
   * setTimeout-backed sleep.
   */
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface CloudflareErrorEntry {
  code: number;
  message: string;
}

export class CloudflareApiError extends Error {
  readonly status: number;
  readonly errors: CloudflareErrorEntry[];
  readonly messages: CloudflareErrorEntry[];
  constructor(
    message: string,
    opts: { status: number; errors?: CloudflareErrorEntry[]; messages?: CloudflareErrorEntry[] },
  ) {
    super(message);
    this.name = 'CloudflareApiError';
    this.status = opts.status;
    this.errors = opts.errors ?? [];
    this.messages = opts.messages ?? [];
  }
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: CloudflareErrorEntry[];
  messages?: CloudflareErrorEntry[];
  result?: T;
}

const DEFAULT_MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 8000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;
  // Per RFC 7231 Retry-After is either delta-seconds (integer) or HTTP-date.
  // CF Email Service returns delta-seconds; we tolerate both.
  const seconds = Number.parseInt(headerValue, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const ts = Date.parse(headerValue);
  if (Number.isFinite(ts)) {
    const delta = ts - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

export class CloudflareApiClient {
  readonly apiToken: string;
  readonly accountId: string;
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(opts: CloudflareApiClientOptions) {
    this.apiToken = opts.apiToken;
    this.accountId = opts.accountId;
    this.baseUrl = opts.baseUrl ?? 'https://api.cloudflare.com/client/v4';
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleepImpl = opts.sleepImpl ?? defaultSleep;
  }

  async get<T>(path: string, schema?: ZodSchema<T>): Promise<T> {
    return this.request('GET', path, undefined, schema);
  }
  async post<T>(path: string, body: unknown, schema?: ZodSchema<T>): Promise<T> {
    return this.request('POST', path, body, schema);
  }
  async patch<T>(path: string, body: unknown, schema?: ZodSchema<T>): Promise<T> {
    return this.request('PATCH', path, body, schema);
  }
  async put<T>(path: string, body: unknown, schema?: ZodSchema<T>): Promise<T> {
    return this.request('PUT', path, body, schema);
  }
  async delete<T>(path: string, schema?: ZodSchema<T>): Promise<T> {
    return this.request('DELETE', path, undefined, schema);
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    schema?: ZodSchema<T>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiToken}`,
      Accept: 'application/json',
    };
    let serializedBody: string | undefined;
    if (body !== undefined) {
      serializedBody = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }

    // 4a.10: retry on 429/503 with exponential backoff, honouring
    // Retry-After when supplied. We do NOT retry on other 4xx (those are
    // request-shape bugs the operator must fix) and do not retry on 5xx
    // other than 503 (those are usually CF surface-area outages where
    // burst retries make things worse). Caps at 3 attempts after the
    // initial request.
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await this.fetchImpl(url, { method, headers, body: serializedBody });
      let envelope: CfEnvelope<T> | undefined;
      let raw = '';
      try {
        raw = await res.text();
        envelope = raw ? (JSON.parse(raw) as CfEnvelope<T>) : undefined;
      } catch {
        // not json
      }
      const isRetryable = res.status === 429 || res.status === 503;
      if (isRetryable && attempt < this.maxRetries) {
        const fromHeader = parseRetryAfter(res.headers.get('retry-after'));
        const backoff = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS);
        const waitMs = fromHeader ?? backoff;
        attempt++;
        await this.sleepImpl(waitMs);
        continue;
      }
      if (!res.ok || !envelope || envelope.success === false) {
        const errs = envelope?.errors ?? [];
        const msg = errs.length
          ? errs.map((e) => `[${e.code}] ${e.message}`).join('; ')
          : `HTTP ${res.status}: ${raw.slice(0, 200)}`;
        throw new CloudflareApiError(`Cloudflare API error: ${msg}`, {
          status: res.status,
          errors: errs,
          messages: envelope?.messages ?? [],
        });
      }
      const result = envelope.result as T;
      if (schema) return schema.parse(result);
      return result;
    }
  }
}
