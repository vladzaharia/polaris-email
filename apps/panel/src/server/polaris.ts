// HMAC client to polaris-email-api, used by every admin route handler.
import { sign, generateNonce } from '@polaris-email/hmac';

export interface PolarisClient {
  call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    query?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; body: T }>;
}

export function makePolaris(opts: {
  baseUrl: string;
  keyId: string;
  keySecret: string;
}): PolarisClient {
  const base = opts.baseUrl.replace(/\/$/, '');
  return {
    async call(method, path, body, query, extraHeaders) {
      const text = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
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
          body: text,
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
          ...(extraHeaders ?? {}),
        },
        body: method === 'GET' || method === 'HEAD' ? undefined : text,
      });
      const t = await res.text();
      let parsed: unknown = t;
      try {
        parsed = JSON.parse(t);
      } catch {
        // not JSON
      }
      return { status: res.status, body: parsed as never };
    },
  };
}
