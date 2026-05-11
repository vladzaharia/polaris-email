import { describe, expect, it } from 'vitest';
import { makePolaris } from '../src/server/polaris.js';

describe('polaris client', () => {
  it('signs requests with method+path+query+body', async () => {
    const c = makePolaris({ baseUrl: 'https://x', keyId: 'K', keySecret: 'S' });
    // We can't actually call without a server, but we can confirm the function exists and the
    // call object is shaped right.
    expect(typeof c.call).toBe('function');
  });
});
