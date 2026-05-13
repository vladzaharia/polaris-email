import { describe, it, expect } from 'vitest';
import { StaticProviderRegistry } from '../src/registry.js';
import type { Provider, SendOutcome, SendRequest } from '../src/provider.js';

class FakeProvider implements Provider {
  constructor(private n: string) {}
  name(): string {
    return this.n;
  }
  async send(_req: SendRequest): Promise<SendOutcome> {
    return { kind: 'accepted' };
  }
}

describe('StaticProviderRegistry', () => {
  const cf = new FakeProvider('cloudflare');
  const ses = new FakeProvider('ses');
  const postmark = new FakeProvider('postmark');

  it('returns the exact-match domain provider', () => {
    const reg = new StaticProviderRegistry({
      providers: [cf, ses],
      defaultProviderName: 'cloudflare',
      domains: [
        { name: 'acme.com', provider: 'cloudflare', wildcard_subdomains: true },
        { name: 'billing.acme.com', provider: 'ses', wildcard_subdomains: false },
      ],
    });
    expect(reg.forDomain('billing.acme.com').name()).toBe('ses');
    expect(reg.forDomain('acme.com').name()).toBe('cloudflare');
  });

  it('walks subdomain → parent (most-specific-wins)', () => {
    const reg = new StaticProviderRegistry({
      providers: [cf, ses],
      defaultProviderName: 'cloudflare',
      domains: [
        { name: 'acme.com', provider: 'ses', wildcard_subdomains: true },
        { name: 'billing.acme.com', provider: 'cloudflare', wildcard_subdomains: false },
      ],
    });
    // billing.acme.com matches the explicit override
    expect(reg.forDomain('billing.acme.com').name()).toBe('cloudflare');
    // notifications.acme.com inherits from the parent (acme.com -> ses)
    expect(reg.forDomain('notifications.acme.com').name()).toBe('ses');
  });

  it('does not inherit when wildcard_subdomains=false', () => {
    const reg = new StaticProviderRegistry({
      providers: [cf, ses],
      defaultProviderName: 'cloudflare',
      domains: [{ name: 'acme.com', provider: 'ses', wildcard_subdomains: false }],
    });
    // acme.com matches; foo.acme.com falls through to default
    expect(reg.forDomain('acme.com').name()).toBe('ses');
    expect(reg.forDomain('foo.acme.com').name()).toBe('cloudflare');
  });

  it('falls back to default for unknown domains', () => {
    const reg = new StaticProviderRegistry({
      providers: [cf, ses],
      defaultProviderName: 'cloudflare',
      domains: [],
    });
    expect(reg.forDomain('unknown.example').name()).toBe('cloudflare');
  });

  it('byName returns the provider or undefined', () => {
    const reg = new StaticProviderRegistry({
      providers: [cf, ses, postmark],
      defaultProviderName: 'cloudflare',
      domains: [],
    });
    expect(reg.byName('ses')?.name()).toBe('ses');
    expect(reg.byName('nonexistent')).toBeUndefined();
  });

  it('throws if defaultProviderName is unknown', () => {
    expect(() => {
      new StaticProviderRegistry({
        providers: [cf],
        defaultProviderName: 'mystery',
        domains: [],
      });
    }).toThrow(/unknown default provider/);
  });
});
