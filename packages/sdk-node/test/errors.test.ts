import { describe, expect, it } from 'vitest';
import { Polaris } from '../src/index.js';
import {
  PolarisError,
  isPolarisError,
  isRetryable,
  parsePolarisError,
} from '../src/errors.js';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function textResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html', ...headers },
  });
}

describe('parsePolarisError', () => {
  it('parses the standard envelope', () => {
    const err = parsePolarisError(
      429,
      {
        error: {
          code: 'rate_limited',
          message: 'slow down',
          retryable: true,
          request_id: 'req_abc',
        },
      },
      null,
    );
    expect(err).toBeInstanceOf(PolarisError);
    expect(err.code).toBe('rate_limited');
    expect(err.message).toBe('slow down');
    expect(err.status).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.requestId).toBe('req_abc');
    expect(err.name).toBe('PolarisError');
  });

  it('falls back to the X-Request-Id header when the envelope omits request_id', () => {
    const err = parsePolarisError(
      403,
      { error: { code: 'forbidden', message: 'no', retryable: false } },
      new Headers({ 'x-request-id': 'req_header' }),
    );
    expect(err.requestId).toBe('req_header');
    expect(err.retryable).toBe(false);
  });

  it('handles non-JSON 502 bodies with code "unknown" and retryable=true', () => {
    const err = parsePolarisError(
      502,
      '<html><body>Bad gateway</body></html>',
      { 'X-Request-Id': 'req_502' },
    );
    expect(err.code).toBe('unknown');
    expect(err.status).toBe(502);
    expect(err.retryable).toBe(true);
    expect(err.requestId).toBe('req_502');
  });

  it('handles non-JSON 404 bodies with retryable=false', () => {
    const err = parsePolarisError(404, 'not found', null);
    expect(err.code).toBe('unknown');
    expect(err.retryable).toBe(false);
    expect(err.requestId).toBeNull();
  });

  it('parses a stringified envelope body', () => {
    const body = JSON.stringify({
      error: { code: 'scope_violation', message: 'nope', retryable: false, request_id: 'req_403' },
    });
    const err = parsePolarisError(403, body, null);
    expect(err.code).toBe('scope_violation');
    expect(err.requestId).toBe('req_403');
  });

  it('treats an envelope without `code` as a parse failure', () => {
    const err = parsePolarisError(400, { error: { message: 'no code field' } }, null);
    expect(err.code).toBe('unknown');
    expect(err.retryable).toBe(false);
  });
});

describe('isPolarisError', () => {
  it('returns true for PolarisError instances', () => {
    expect(isPolarisError(new PolarisError('x', 'y', 500, true, null))).toBe(true);
  });
  it('returns false for plain Errors', () => {
    expect(isPolarisError(new Error('x'))).toBe(false);
  });
  it('returns false for non-errors', () => {
    expect(isPolarisError(null)).toBe(false);
    expect(isPolarisError({ code: 'rate_limited' })).toBe(false);
  });
});

describe('isRetryable', () => {
  it('mirrors PolarisError.retryable', () => {
    expect(isRetryable(new PolarisError('x', 'rate_limited', 429, true, null))).toBe(true);
    expect(isRetryable(new PolarisError('x', 'scope_violation', 403, false, null))).toBe(false);
  });
  it('returns false for unknown errors', () => {
    expect(isRetryable(new Error('boom'))).toBe(false);
    expect(isRetryable(null)).toBe(false);
  });
});

describe('Polaris client throws PolarisError on non-2xx', () => {
  it('throws with the parsed envelope on a 429', async () => {
    const stub = (async () =>
      jsonResponse(
        429,
        {
          error: {
            code: 'rate_limited',
            message: 'slow down',
            retryable: true,
            request_id: 'req_abc',
          },
        },
        { 'x-request-id': 'req_abc' },
      )) as unknown as typeof fetch;
    const client = new Polaris({ baseUrl: 'https://api.example.test', fetch: stub });

    try {
      await client.listMessages();
      throw new Error('expected throw');
    } catch (e) {
      expect(isPolarisError(e)).toBe(true);
      if (isPolarisError(e)) {
        expect(e.code).toBe('rate_limited');
        expect(e.status).toBe(429);
        expect(e.retryable).toBe(true);
        expect(e.requestId).toBe('req_abc');
        expect(isRetryable(e)).toBe(true);
      }
    }
  });

  it('throws PolarisError("unknown") on a non-JSON 502', async () => {
    const stub = (async () =>
      textResponse(502, '<html>bad gateway</html>', {
        'x-request-id': 'req_502',
      })) as unknown as typeof fetch;
    const client = new Polaris({ baseUrl: 'https://api.example.test', fetch: stub });

    try {
      await client.listMessages();
      throw new Error('expected throw');
    } catch (e) {
      expect(isPolarisError(e)).toBe(true);
      if (isPolarisError(e)) {
        expect(e.code).toBe('unknown');
        expect(e.status).toBe(502);
        expect(e.retryable).toBe(true);
        expect(e.requestId).toBe('req_502');
      }
    }
  });

  it('throws PolarisError on a 403 with retryable=false', async () => {
    const stub = (async () =>
      jsonResponse(403, {
        error: {
          code: 'scope_violation',
          message: 'from outside scope',
          retryable: false,
          request_id: 'req_403',
        },
      })) as unknown as typeof fetch;
    const client = new Polaris({ baseUrl: 'https://api.example.test', fetch: stub });

    try {
      await client.sendMessage({ from: 'a@b', to: ['c@d'], subject: '', text: '' } as never);
      throw new Error('expected throw');
    } catch (e) {
      expect(isPolarisError(e)).toBe(true);
      if (isPolarisError(e)) {
        expect(e.code).toBe('scope_violation');
        expect(e.retryable).toBe(false);
        expect(isRetryable(e)).toBe(false);
      }
    }
  });

  it('returns the parsed body on 2xx without throwing', async () => {
    const stub = (async () =>
      jsonResponse(200, { data: [] })) as unknown as typeof fetch;
    const client = new Polaris({ baseUrl: 'https://api.example.test', fetch: stub });
    const res = await client.listMessages();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
  });
});
