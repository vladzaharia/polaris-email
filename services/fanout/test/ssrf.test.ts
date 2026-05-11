import { describe, expect, it } from 'vitest';
import { ssrfCheck } from '../src/ssrf.js';

const bridge = 'polaris-email.tail.ts.net';

describe('ssrfCheck', () => {
  it('accepts public https', () => {
    expect(ssrfCheck({ url: 'https://api.example.com/h', kind: 'external', bridgeHost: bridge })).toEqual({
      ok: true,
    });
  });
  it('rejects http external', () => {
    expect(
      ssrfCheck({ url: 'http://api.example.com/h', kind: 'external', bridgeHost: bridge }).ok,
    ).toBe(false);
  });
  it('rejects file://', () => {
    expect(ssrfCheck({ url: 'file:///etc/passwd', kind: 'external', bridgeHost: bridge }).ok).toBe(false);
  });
  it('rejects IMDS', () => {
    expect(
      ssrfCheck({ url: 'http://169.254.169.254/', kind: 'external', bridgeHost: bridge }).ok,
    ).toBe(false);
    expect(
      ssrfCheck({
        url: 'http://metadata.google.internal/',
        kind: 'external',
        bridgeHost: bridge,
      }).ok,
    ).toBe(false);
  });
  it('rejects IP literal for non-bridge', () => {
    expect(
      ssrfCheck({ url: 'http://8.8.8.8/', kind: 'tailnet', bridgeHost: bridge }).ok,
    ).toBe(false);
    expect(
      ssrfCheck({ url: 'http://1.2.3.4/', kind: 'external', bridgeHost: bridge }).ok,
    ).toBe(false);
  });
  it('rejects 10/8 and 192.168/16', () => {
    expect(ssrfCheck({ url: 'http://10.0.0.1/', kind: 'bridge', bridgeHost: bridge }).ok).toBe(false);
    expect(
      ssrfCheck({ url: 'http://192.168.1.1/', kind: 'bridge', bridgeHost: bridge }).ok,
    ).toBe(false);
  });
  it('rejects tailnet without .ts.net', () => {
    expect(
      ssrfCheck({ url: 'https://svc.local/h', kind: 'tailnet', bridgeHost: bridge }).ok,
    ).toBe(false);
    expect(
      ssrfCheck({ url: 'https://svc.tail.ts.net/h', kind: 'tailnet', bridgeHost: bridge }).ok,
    ).toBe(true);
  });
  it('rejects bridge with wrong host', () => {
    expect(
      ssrfCheck({ url: 'https://attacker.ts.net/h', kind: 'bridge', bridgeHost: bridge }).ok,
    ).toBe(false);
    expect(
      ssrfCheck({ url: `https://${bridge}/hooks/x/y`, kind: 'bridge', bridgeHost: bridge }).ok,
    ).toBe(true);
  });
});
