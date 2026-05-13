import { describe, expect, it } from 'vitest';
import { ssrfCheck } from '../src/ssrf.js';

describe('ssrfCheck', () => {
  it('accepts public https', () => {
    expect(ssrfCheck({ url: 'https://api.example.com/h', kind: 'external' })).toEqual({
      ok: true,
    });
  });
  it('rejects http external', () => {
    expect(ssrfCheck({ url: 'http://api.example.com/h', kind: 'external' }).ok).toBe(false);
  });
  it('rejects file://', () => {
    expect(ssrfCheck({ url: 'file:///etc/passwd', kind: 'external' }).ok).toBe(false);
  });
  it('rejects IMDS', () => {
    expect(ssrfCheck({ url: 'http://169.254.169.254/', kind: 'external' }).ok).toBe(false);
    expect(ssrfCheck({ url: 'http://metadata.google.internal/', kind: 'external' }).ok).toBe(
      false,
    );
  });
  it('rejects IP literals on any kind', () => {
    expect(ssrfCheck({ url: 'http://8.8.8.8/', kind: 'tailnet' }).ok).toBe(false);
    expect(ssrfCheck({ url: 'http://1.2.3.4/', kind: 'external' }).ok).toBe(false);
  });
  it('rejects private hostname prefixes', () => {
    expect(ssrfCheck({ url: 'http://10.0.0.1/', kind: 'external' }).ok).toBe(false);
    expect(ssrfCheck({ url: 'http://192.168.1.1/', kind: 'external' }).ok).toBe(false);
  });
  it('rejects tailnet without .ts.net', () => {
    expect(ssrfCheck({ url: 'https://svc.local/h', kind: 'tailnet' }).ok).toBe(false);
    expect(ssrfCheck({ url: 'https://svc.tail.ts.net/h', kind: 'tailnet' }).ok).toBe(true);
  });
});
