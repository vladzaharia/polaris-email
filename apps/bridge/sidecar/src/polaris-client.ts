// HMAC client to the polaris-email-api.
import { sign, generateNonce } from '@polaris-email/hmac';

export interface PolarisClient {
  request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    query?: string,
  ): Promise<{ status: number; body: T }>;
}

export function makeClient(opts: {
  baseUrl: string;
  keyId: string;
  keySecret: string;
}): PolarisClient {
  const base = opts.baseUrl.replace(/\/$/, '');
  return {
    async request(method, path, body, query) {
      const bodyText = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
      const ts = String(Date.now());
      const nonce = generateNonce();
      const q = query ?? '';
      const sig = await sign(
        {
          direction: 'polaris-api.v1',
          method,
          path,
          query: q,
          ts,
          nonce,
          body: bodyText,
        },
        opts.keySecret,
      );
      const res = await fetch(base + path + (q ? '?' + q.replace(/^\?/, '') : ''), {
        method,
        headers: {
          'content-type': 'application/json',
          'x-polaris-key-id': opts.keyId,
          'x-polaris-ts': ts,
          'x-polaris-nonce': nonce,
          'x-polaris-sig': sig,
        },
        body: method === 'GET' || method === 'HEAD' ? undefined : bodyText,
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // not JSON; keep as string
      }
      return { status: res.status, body: parsed as never };
    },
  };
}
