// Thin adapter over `@polaris/sdk`'s `Polaris` class. Pre-Phase-F this file
// hand-rolled HMAC signing; that wrapper now lives in the SDK so the panel
// shares one transport with the CLI, the daemon, and third-party consumers.
//
// The `PolarisClient` interface is preserved so individual route files don't
// have to change. Phase G/H will swap the HMAC `authBuilder` for a
// service-binding token once the panel runs on Workers.
import { Polaris, type PolarisRequest } from '@polaris/sdk';
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
  const sdk = new Polaris({
    baseUrl: opts.baseUrl,
    authBuilder: async (req: PolarisRequest) => {
      const ts = String(Date.now());
      const nonce = generateNonce();
      const sig = await sign(
        {
          direction: 'polaris-api.v1',
          method: req.method,
          path: req.path,
          query: req.query ?? '',
          ts,
          nonce,
          body: req.body == null ? '' : new TextDecoder().decode(req.body),
        },
        opts.keySecret,
      );
      return {
        'x-polaris-key-id': opts.keyId,
        'x-polaris-ts': ts,
        'x-polaris-nonce': nonce,
        'x-polaris-sig': sig,
      };
    },
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
