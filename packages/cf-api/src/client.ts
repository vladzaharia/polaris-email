import type { ZodSchema } from 'zod';

export interface CloudflareApiClientOptions {
  apiToken: string;
  accountId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
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

export class CloudflareApiClient {
  readonly apiToken: string;
  readonly accountId: string;
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CloudflareApiClientOptions) {
    this.apiToken = opts.apiToken;
    this.accountId = opts.accountId;
    this.baseUrl = opts.baseUrl ?? 'https://api.cloudflare.com/client/v4';
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
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
    const res = await this.fetchImpl(url, { method, headers, body: serializedBody });
    let envelope: CfEnvelope<T> | undefined;
    let raw = '';
    try {
      raw = await res.text();
      envelope = raw ? (JSON.parse(raw) as CfEnvelope<T>) : undefined;
    } catch {
      // not json
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
