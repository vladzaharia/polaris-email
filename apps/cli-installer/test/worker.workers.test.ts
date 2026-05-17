// Worker-level tests for the cli-installer Worker.
//
// Uses `@cloudflare/vitest-pool-workers` (mirrors services/api). We invoke
// the worker's default export directly via `worker.fetch(req, env, ctx)`;
// `SELF.fetch` would also work for a fetch-only Worker but direct
// invocation avoids the extra isolate hop.
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';

function call(url: string): Promise<Response> {
  const req = new Request(url);
  const ctx = createExecutionContext();
  // The Worker's fetch handler is synchronous; wrap in Promise.resolve so
  // tests can await uniformly with future async additions.
  return Promise.resolve(worker.fetch!(req, env as never, ctx));
}

describe('cli-installer Worker', () => {
  it('GET /healthz -> 200 {ok: true}', async () => {
    const res = await call('https://cli.mail.plrs.im/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });
  });

  it('GET / serves the install script with the right headers', async () => {
    const res = await call('https://cli.mail.plrs.im/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/x-shellscript/);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await res.text();
    expect(body.startsWith('#!/usr/bin/env sh')).toBe(true);
    // Default (unpinned) install — POLARIS_PIN_VERSION should be empty.
    expect(body).toMatch(/^POLARIS_PIN_VERSION=''$/m);
  });

  it('GET /sh is identical in shape to GET /', async () => {
    const res = await call('https://cli.mail.plrs.im/sh');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/x-shellscript/);
    const body = await res.text();
    expect(body.startsWith('#!/usr/bin/env sh')).toBe(true);
  });

  it('GET /?v=v1.2.3 pins the version in the script body', async () => {
    const res = await call('https://cli.mail.plrs.im/?v=v1.2.3');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/^POLARIS_PIN_VERSION='v1\.2\.3'$/m);
  });

  it('GET /?v=1.2.3 (no v prefix) is accepted', async () => {
    const res = await call('https://cli.mail.plrs.im/?v=1.2.3');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/^POLARIS_PIN_VERSION='1\.2\.3'$/m);
  });

  it('GET /?v=v1.2.3-rc.1 (prerelease suffix) is accepted', async () => {
    const res = await call('https://cli.mail.plrs.im/?v=v1.2.3-rc.1');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/^POLARIS_PIN_VERSION='v1\.2\.3-rc\.1'$/m);
  });

  it('GET /?v=<malicious> rejects unsafe input and leaves pin empty', async () => {
    // URL-encoded `$(rm -rf /)` — exercises the safety regex. The script
    // itself contains a legitimate `rm -rf "$tmp"` cleanup, so we assert on
    // the absence of the substitution-flavoured payload instead.
    const res = await call('https://cli.mail.plrs.im/?v=' + encodeURIComponent('$(rm -rf /)'));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/^POLARIS_PIN_VERSION=''$/m);
    expect(body).not.toContain('$(rm');
    expect(body).not.toContain("POLARIS_PIN_VERSION='$(");
  });

  it('GET /?v=<too-long> rejects oversized input', async () => {
    const huge = 'v1.' + '2'.repeat(200);
    const res = await call('https://cli.mail.plrs.im/?v=' + huge);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/^POLARIS_PIN_VERSION=''$/m);
  });

  it('GET /unknown -> 404', async () => {
    const res = await call('https://cli.mail.plrs.im/unknown');
    expect(res.status).toBe(404);
  });
});
