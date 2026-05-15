// SSRF defence tests for the fanout queue consumer. Originally lived at
// services/fanout/test/ssrf.test.ts; folded in during the B1 worker
// consolidation. Same coverage; only the import path changed.
import { describe, expect, it } from 'vitest';
import { ssrfCheck, safeFetch, ipDenied, type DnsResolver } from '../../src/queue/ssrf.js';

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
    expect(ssrfCheck({ url: 'http://metadata.google.internal/', kind: 'external' }).ok).toBe(false);
  });
  it('rejects IP literals on any kind', () => {
    expect(ssrfCheck({ url: 'http://8.8.8.8/', kind: 'tailnet' }).ok).toBe(false);
    expect(ssrfCheck({ url: 'http://1.2.3.4/', kind: 'external' }).ok).toBe(false);
  });
  it('rejects RFC 1918 private ranges (A6 coverage)', () => {
    // 10.0.0.0/8
    expect(ssrfCheck({ url: 'http://10.0.0.1/', kind: 'external' }).ok).toBe(false);
    // 172.16.0.0/12 — the gap this phase plugs.
    expect(ssrfCheck({ url: 'http://172.16.0.5/', kind: 'external' }).ok).toBe(false);
    expect(ssrfCheck({ url: 'http://172.20.255.255/', kind: 'external' }).ok).toBe(false);
    expect(ssrfCheck({ url: 'http://172.31.255.254/', kind: 'external' }).ok).toBe(false);
    // 192.168.0.0/16
    expect(ssrfCheck({ url: 'http://192.168.1.1/', kind: 'external' }).ok).toBe(false);
  });
  it('does NOT mistakenly block 172.32+ (just outside the /12)', () => {
    // The string-prefix bug treated "172." as private. The /12 range is
    // 172.16.0.0 — 172.31.255.255 ONLY. 172.32.x.x is public.
    expect(ipDenied('172.32.0.1')).toBe(false);
    expect(ipDenied('172.15.255.255')).toBe(false);
  });
  it('rejects CGNAT 100.64.0.0/10 (A6 coverage)', () => {
    expect(ssrfCheck({ url: 'http://100.64.0.5/', kind: 'external' }).ok).toBe(false);
    expect(ssrfCheck({ url: 'http://100.127.255.254/', kind: 'external' }).ok).toBe(false);
    // Just outside the range — 100.128.x.x is public.
    expect(ipDenied('100.128.0.1')).toBe(false);
    expect(ipDenied('100.63.255.255')).toBe(false);
  });
  it('rejects loopback and link-local v4', () => {
    expect(ipDenied('127.0.0.1')).toBe(true);
    expect(ipDenied('127.255.255.254')).toBe(true);
    expect(ipDenied('169.254.0.1')).toBe(true);
  });
  it('rejects v6 loopback and ULA / link-local prefixes', () => {
    expect(ipDenied('::1')).toBe(true);
    expect(ipDenied('fc00::1')).toBe(true);
    expect(ipDenied('fd12:3456::1')).toBe(true);
    expect(ipDenied('fe80::1')).toBe(true);
    expect(ipDenied('feb0::1')).toBe(true);
    // Public v6 should be allowed.
    expect(ipDenied('2606:4700:4700::1111')).toBe(false);
  });
  it('rejects bracketed v6 literals (always — even private ones)', () => {
    expect(ssrfCheck({ url: 'http://[::1]/', kind: 'external' }).ok).toBe(false);
    expect(ssrfCheck({ url: 'http://[fc00::1]/', kind: 'external' }).ok).toBe(false);
    expect(ssrfCheck({ url: 'http://[2001:db8::1]/', kind: 'external' }).ok).toBe(false);
  });
  it('allows public v4 ips (via ipDenied — they would still be rejected by ssrfCheck as literals)', () => {
    expect(ipDenied('8.8.8.8')).toBe(false);
    expect(ipDenied('1.1.1.1')).toBe(false);
  });
  it('rejects tailnet without .ts.net', () => {
    expect(ssrfCheck({ url: 'https://svc.local/h', kind: 'tailnet' }).ok).toBe(false);
    expect(ssrfCheck({ url: 'https://svc.tail.ts.net/h', kind: 'tailnet' }).ok).toBe(true);
  });
});

describe('safeFetch DNS pinning', () => {
  it('rejects when DNS resolves to a private IP (TOCTOU defence)', async () => {
    const evilResolver: DnsResolver = async () => ['10.0.0.5'];
    const result = await safeFetch('https://attacker.example.com/h', 'external', {
      resolve: evilResolver,
      timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
  });
  it('rejects when DNS resolves to CGNAT (100.64/10)', async () => {
    const evilResolver: DnsResolver = async () => ['100.64.0.5'];
    const result = await safeFetch('https://attacker.example.com/h', 'external', {
      resolve: evilResolver,
      timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
  });
  it('rejects when DNS resolves to a v6 ULA', async () => {
    const evilResolver: DnsResolver = async () => ['fc00::1'];
    const result = await safeFetch('https://attacker.example.com/h', 'external', {
      resolve: evilResolver,
      timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
  });
  it('rejects when DNS resolution returns no answers (fail-closed)', async () => {
    const emptyResolver: DnsResolver = async () => [];
    const result = await safeFetch('https://nx.example.com/h', 'external', {
      resolve: emptyResolver,
      timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
  });
});
