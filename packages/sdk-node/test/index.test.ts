import { describe, expect, it } from 'vitest';
import { Polaris, assertIdempotencyKey } from '../src/index.js';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('assertIdempotencyKey', () => {
  it('accepts valid keys', () => {
    expect(() => assertIdempotencyKey('abcd-EFGH_1234')).not.toThrow();
    expect(() => assertIdempotencyKey('A'.repeat(8))).not.toThrow();
    expect(() => assertIdempotencyKey('A'.repeat(128))).not.toThrow();
  });
  it('rejects too-short keys', () => {
    expect(() => assertIdempotencyKey('short')).toThrow(TypeError);
  });
  it('rejects too-long keys', () => {
    expect(() => assertIdempotencyKey('A'.repeat(129))).toThrow(TypeError);
  });
  it('rejects keys with disallowed chars', () => {
    expect(() => assertIdempotencyKey('hello world!')).toThrow(TypeError);
    expect(() => assertIdempotencyKey('a.b.c.d.e')).toThrow(TypeError);
    expect(() => assertIdempotencyKey('emoji-key')).not.toThrow();
    // U+00FF (ÿ) is outside [A-Za-z0-9_-]
    expect(() => assertIdempotencyKey('valid-but-ÿ')).toThrow(TypeError);
  });
});

describe('Polaris.sendMessage idempotency-key validation', () => {
  it('rejects an invalid idempotency-key before fetching', async () => {
    let called = false;
    const stub = (async () => {
      called = true;
      return jsonResponse(200, { message_id: 'x', status: 'queued', fresh: true });
    }) as unknown as typeof fetch;
    const c = new Polaris({ baseUrl: 'https://api.test', fetch: stub });
    await expect(
      c.sendMessage({ from: 'a@b', to: ['c@d'], subject: '', text: '' } as never, {
        idempotencyKey: 'bad key',
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(called).toBe(false);
  });

  it('accepts a well-formed key and forwards as a header', async () => {
    let seenHeader: string | null = null;
    const stub = (async (_url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      seenHeader = h['idempotency-key'] ?? null;
      return jsonResponse(200, { message_id: 'x', status: 'queued', fresh: true });
    }) as unknown as typeof fetch;
    const c = new Polaris({ baseUrl: 'https://api.test', fetch: stub });
    await c.sendMessage({ from: 'a@b', to: ['c@d'], subject: '', text: '' } as never, {
      idempotencyKey: 'order-12345-confirm',
    });
    expect(seenHeader).toBe('order-12345-confirm');
  });
});

describe('Polaris.listAllMessages auto-pagination', () => {
  it('walks next_offset and yields all messages', async () => {
    const pages = new Map<string, unknown>([
      [
        '/v1/messages?limit=2',
        { data: [{ id: 'a' }, { id: 'b' }], next_offset: 2 },
      ],
      [
        '/v1/messages?limit=2&offset=2',
        { data: [{ id: 'c' }, { id: 'd' }], next_offset: 4 },
      ],
      [
        '/v1/messages?limit=2&offset=4',
        { data: [{ id: 'e' }], next_offset: null },
      ],
    ]);
    const seenUrls: string[] = [];
    const stub = (async (url: string) => {
      const path = new URL(url).pathname + new URL(url).search;
      seenUrls.push(path);
      const body = pages.get(path);
      if (!body) throw new Error(`no stub for ${path}`);
      return jsonResponse(200, body);
    }) as unknown as typeof fetch;

    const c = new Polaris({ baseUrl: 'https://api.test', fetch: stub });
    const ids: string[] = [];
    for await (const m of c.listAllMessages('limit=2')) {
      ids.push((m as { id: string }).id);
    }
    expect(ids).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(seenUrls).toEqual([
      '/v1/messages?limit=2',
      '/v1/messages?limit=2&offset=2',
      '/v1/messages?limit=2&offset=4',
    ]);
  });

  it('terminates immediately when first page has next_offset=null', async () => {
    const stub = (async () =>
      jsonResponse(200, { data: [{ id: 'only' }], next_offset: null })) as unknown as typeof fetch;
    const c = new Polaris({ baseUrl: 'https://api.test', fetch: stub });
    let count = 0;
    for await (const _ of c.listAllMessages()) count++;
    expect(count).toBe(1);
  });

  it('yields nothing when first page is empty', async () => {
    const stub = (async () =>
      jsonResponse(200, { data: [], next_offset: null })) as unknown as typeof fetch;
    const c = new Polaris({ baseUrl: 'https://api.test', fetch: stub });
    let count = 0;
    for await (const _ of c.listAllMessages()) count++;
    expect(count).toBe(0);
  });
});
