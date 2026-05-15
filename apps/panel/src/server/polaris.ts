// Polaris SDK adapter for the panel Worker.
//
// In the Worker runtime the panel talks to services/api via the `API` service
// binding (`env.API.fetch.bind(env.API)`). The SDK accepts a custom `fetch`
// implementation; when service-bound there's no HMAC needed (the bindings
// authenticate platform-side), but we keep the auth builder available for the
// fallback path where the panel calls a different host over plain HTTPS.
import { Polaris, type PolarisRequest } from '@polaris/sdk';
import { sign, generateNonce } from '@polaris-email/hmac';
import type { Env } from './env.js';

export interface PolarisClient {
  call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    query?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; body: T }>;
}

export function makePolaris(env: Env): PolarisClient {
  const hasHmac = Boolean(env.PANEL_ADMIN_KEY_ID && env.PANEL_ADMIN_KEY_SECRET);
  const sdk = new Polaris({
    // baseUrl is ignored when fetch is the service binding (the binding
    // routes by name, not by URL), but the SDK still requires a value for
    // building the request URL passed to `fetch`.
    baseUrl: 'https://polaris-email-api.invalid',
    fetch: env.API.fetch.bind(env.API),
    ...(hasHmac
      ? {
          authBuilder: async (req: PolarisRequest) => {
            const ts = String(Date.now());
            const nonce = generateNonce();
            const sig = await sign(
              {
                direction: 'polaris-api',
                method: req.method,
                path: req.path,
                query: req.query ?? '',
                ts,
                nonce,
                body: req.body == null ? '' : new TextDecoder().decode(req.body),
              },
              env.PANEL_ADMIN_KEY_SECRET as string,
            );
            return {
              'x-polaris-key-id': env.PANEL_ADMIN_KEY_ID as string,
              'x-polaris-ts': ts,
              'x-polaris-nonce': nonce,
              'x-polaris-sig': sig,
            };
          },
        }
      : {}),
  });

  return {
    async call(method, path, body, query, extraHeaders) {
      const res = await sdk.call(method, path, {
        body: body ?? undefined,
        query: query ?? undefined,
        extraHeaders: extraHeaders ?? undefined,
      });
      return { status: res.status, body: res.body as never };
    },
  };
}
