// Provider registry. Resolves outbound provider for a given domain.
//
// Lookup precedence (most-specific-wins, mirrors sender resolution):
//   1. Exact domain match → that domain's `provider` column
//   2. Walk up parent domains (most-specific suffix-match)
//   3. Fall back to the configured default provider

import type { Provider, ProviderRegistry } from './provider.js';

export interface DomainRow {
  /** Full domain name (e.g., "billing.acme.com" or "acme.com"). */
  name: string;
  /** Provider name; matches `Provider.name()`. */
  provider: string;
  /** Set on subdomain rows that explicitly override their parent. */
  parent_domain_id?: string | null;
  /** True when this domain's settings should also cover its subdomains. */
  wildcard_subdomains?: boolean;
}

export class StaticProviderRegistry implements ProviderRegistry {
  private byNameMap: Map<string, Provider>;
  private domains: DomainRow[];
  private defaultProvider: Provider;

  constructor(opts: {
    providers: Provider[];
    defaultProviderName: string;
    /** Pre-loaded domain rows from `polaris-control` D1. */
    domains: DomainRow[];
  }) {
    this.byNameMap = new Map(opts.providers.map((p) => [p.name(), p]));
    const def = this.byNameMap.get(opts.defaultProviderName);
    if (!def) {
      throw new Error(`unknown default provider: ${opts.defaultProviderName}`);
    }
    this.defaultProvider = def;
    // Sort by descending name length so longest-suffix match is found first.
    this.domains = [...opts.domains].sort((a, b) => b.name.length - a.name.length);
  }

  forDomain(domain: string): Provider {
    const lc = domain.toLowerCase();
    for (const d of this.domains) {
      if (lc === d.name) {
        return this.byNameMap.get(d.provider) ?? this.defaultProvider;
      }
      if (d.wildcard_subdomains && lc.endsWith('.' + d.name)) {
        return this.byNameMap.get(d.provider) ?? this.defaultProvider;
      }
    }
    return this.defaultProvider;
  }

  byName(name: string): Provider | undefined {
    return this.byNameMap.get(name);
  }
}
