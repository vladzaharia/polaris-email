import { describe, expect, it } from 'vitest';
import { assertSafeWebhookUrl, isForbiddenIP, UrlGuardError } from '../src/guard.js';

const fixedResolver = (ips: string[]) => async () => ips;

interface Case {
  name: string;
  url: string;
  resolved?: string[];
  allowLocalhost?: boolean;
  expectErr?: string; // UrlGuardError code, undefined = expect pass
}

const CASES: Case[] = [
  // Schemes
  {
    name: 'http to public host is rejected',
    url: 'http://example.com/hook',
    resolved: ['93.184.216.34'],
    expectErr: 'scheme_rejected',
  },
  {
    name: 'http to localhost allowed when opted in',
    url: 'http://localhost:8080/hook',
    resolved: ['127.0.0.1'],
    allowLocalhost: true,
  },
  {
    name: 'unknown scheme rejected',
    url: 'gopher://example.com/hook',
    resolved: ['93.184.216.34'],
    expectErr: 'scheme_rejected',
  },
  // Ports
  {
    name: 'odd port rejected',
    url: 'https://example.com:9999/hook',
    resolved: ['93.184.216.34'],
    expectErr: 'port_rejected',
  },
  {
    name: 'port 443 default ok',
    url: 'https://example.com/hook',
    resolved: ['93.184.216.34'],
  },
  {
    name: 'port 8443 ok',
    url: 'https://example.com:8443/hook',
    resolved: ['93.184.216.34'],
  },
  // Hostnames
  {
    name: '.local rejected',
    url: 'https://printer.local/hook',
    resolved: ['93.184.216.34'],
    expectErr: 'hostname_rejected',
  },
  {
    name: '.internal rejected',
    url: 'https://api.internal/hook',
    resolved: ['93.184.216.34'],
    expectErr: 'hostname_rejected',
  },
  // IP ranges (DNS rebind defense)
  {
    name: 'RFC1918 10/8 rejected',
    url: 'https://example.com/hook',
    resolved: ['10.0.0.5'],
    expectErr: 'ip_rejected',
  },
  {
    name: 'RFC1918 172.16/12 rejected',
    url: 'https://example.com/hook',
    resolved: ['172.20.1.1'],
    expectErr: 'ip_rejected',
  },
  {
    name: 'RFC1918 192.168/16 rejected',
    url: 'https://example.com/hook',
    resolved: ['192.168.1.1'],
    expectErr: 'ip_rejected',
  },
  {
    name: 'CGNAT 100.64/10 rejected',
    url: 'https://example.com/hook',
    resolved: ['100.100.5.5'],
    expectErr: 'ip_rejected',
  },
  {
    name: 'Link-local 169.254/16 rejected',
    url: 'https://example.com/hook',
    resolved: ['169.254.10.10'],
    expectErr: 'ip_rejected',
  },
  {
    name: 'IMDS 169.254.169.254 rejected',
    url: 'https://example.com/hook',
    resolved: ['169.254.169.254'],
    expectErr: 'ip_rejected',
  },
  {
    name: 'loopback 127/8 rejected (no allowLocalhost)',
    url: 'https://example.com/hook',
    resolved: ['127.0.0.1'],
    expectErr: 'ip_rejected',
  },
  {
    name: 'IPv6 ::1 rejected (no allowLocalhost)',
    url: 'https://example.com/hook',
    resolved: ['::1'],
    expectErr: 'ip_rejected',
  },
  {
    name: 'IPv6 fc00::/7 unique-local rejected',
    url: 'https://example.com/hook',
    resolved: ['fd00::1'],
    expectErr: 'ip_rejected',
  },
  {
    name: 'IPv6 link-local fe80::/10 rejected',
    url: 'https://example.com/hook',
    resolved: ['fe80::1'],
    expectErr: 'ip_rejected',
  },
  // Empty DNS
  {
    name: 'empty DNS answer rejected',
    url: 'https://example.com/hook',
    resolved: [],
    expectErr: 'dns_empty',
  },
  // Mixed-result rejection
  {
    name: 'mixed public+private resolved set rejected',
    url: 'https://example.com/hook',
    resolved: ['93.184.216.34', '10.0.0.1'],
    expectErr: 'ip_rejected',
  },
  // IP literal hostname
  {
    name: 'private IP literal rejected',
    url: 'https://10.0.0.1/hook',
    expectErr: 'ip_rejected',
  },
  // Public passes
  {
    name: 'normal public webhook allowed',
    url: 'https://hooks.example.com/abc',
    resolved: ['203.0.113.5'],
  },
];

describe('assertSafeWebhookUrl', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const opts = {
        allowLocalhost: c.allowLocalhost,
        resolve: c.resolved ? fixedResolver(c.resolved) : undefined,
      };
      if (c.expectErr) {
        const err = await assertSafeWebhookUrl(c.url, opts).catch((e) => e);
        expect(err).toBeInstanceOf(UrlGuardError);
        expect((err as UrlGuardError).code).toBe(c.expectErr);
      } else {
        const r = await assertSafeWebhookUrl(c.url, opts);
        expect(r.url).toBeInstanceOf(URL);
        expect(r.resolvedIPs.length).toBeGreaterThan(0);
      }
    });
  }

  it('rejects unparseable URL', async () => {
    const err = await assertSafeWebhookUrl('not a url', {
      resolve: fixedResolver(['1.1.1.1']),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(UrlGuardError);
  });
});

describe('isForbiddenIP edge cases', () => {
  it('flags IPv4-mapped private addresses', () => {
    expect(isForbiddenIP('::ffff:10.0.0.1')).toBe(true);
  });
  it('passes IPv4-mapped public addresses', () => {
    expect(isForbiddenIP('::ffff:93.184.216.34')).toBe(false);
  });
  it('rejects unknown formats defensively', () => {
    expect(isForbiddenIP('garbage')).toBe(true);
  });
});
