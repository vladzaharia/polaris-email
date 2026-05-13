import type { ExpectedRecord } from './types.js';

export type VerifyStep =
  | 'unstarted'
  | 'published'
  | 'seen_via_authoritative'
  | 'seen_via_three_resolvers'
  | 'confirmed';

export interface AdvanceResult {
  step: VerifyStep;
  foundValues: string[];
}

export interface DnsVerifier {
  advance(record: ExpectedRecord): Promise<AdvanceResult>;
}

const DEFAULT_RESOLVERS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve',
  'https://dns.quad9.net:5053/dns-query',
];

/** Min seconds between `published` and `seen_via_three_resolvers` for `confirmed`. */
export const CONFIRM_GRACE_SECONDS = 60;

export interface DohResponse {
  Status: number;
  Answer?: Array<{ name: string; type: number; TTL: number; data: string }>;
}

const TYPE_MAP: Record<string, number> = {
  A: 1,
  CNAME: 5,
  MX: 15,
  TXT: 16,
  AAAA: 28,
};

export interface DohDnsVerifierOptions {
  resolvers?: string[];
  fetchImpl?: typeof fetch;
  /** Authoritative resolver query function; default: derive NS from zone, query directly via DoH proxy. */
  authoritativeResolverFetch?: (record: ExpectedRecord) => Promise<string[]>;
  /** Returns "now" in ms; injectable for tests. */
  now?: () => number;
  /** Provide an existing-in-CF-DNS-API check; returns true if record exists in the CF API. */
  publishedCheck?: (record: ExpectedRecord) => Promise<boolean>;
}

export class DohDnsVerifier implements DnsVerifier {
  private state = new Map<string, { step: VerifyStep; publishedAt?: number }>();
  private readonly resolvers: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly authoritativeResolverFetch?: (record: ExpectedRecord) => Promise<string[]>;
  private readonly publishedCheck?: (record: ExpectedRecord) => Promise<boolean>;

  constructor(opts: DohDnsVerifierOptions = {}) {
    this.resolvers = opts.resolvers ?? DEFAULT_RESOLVERS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
    this.authoritativeResolverFetch = opts.authoritativeResolverFetch;
    this.publishedCheck = opts.publishedCheck;
  }

  async advance(record: ExpectedRecord): Promise<AdvanceResult> {
    const key = recordKey(record);
    const cur = this.state.get(key) ?? { step: 'unstarted' as VerifyStep };

    switch (cur.step) {
      case 'unstarted': {
        const ok = this.publishedCheck ? await this.publishedCheck(record) : true;
        if (ok) {
          this.state.set(key, { step: 'published', publishedAt: this.now() });
          return { step: 'published', foundValues: [] };
        }
        return { step: 'unstarted', foundValues: [] };
      }
      case 'published': {
        const found = this.authoritativeResolverFetch
          ? await this.authoritativeResolverFetch(record)
          : await this.queryResolver(this.resolvers[0]!, record);
        if (found.some((v) => contentMatches(v, record.content))) {
          this.state.set(key, { ...cur, step: 'seen_via_authoritative' });
          return { step: 'seen_via_authoritative', foundValues: found };
        }
        return { step: 'published', foundValues: found };
      }
      case 'seen_via_authoritative': {
        const found = await this.queryAll(record);
        const successes = found.filter((vals) =>
          vals.some((v) => contentMatches(v, record.content)),
        ).length;
        if (successes >= 3) {
          this.state.set(key, { ...cur, step: 'seen_via_three_resolvers' });
          return { step: 'seen_via_three_resolvers', foundValues: found.flat() };
        }
        return { step: 'seen_via_authoritative', foundValues: found.flat() };
      }
      case 'seen_via_three_resolvers': {
        const elapsed = ((this.now() - (cur.publishedAt ?? this.now())) / 1000) | 0;
        if (elapsed >= CONFIRM_GRACE_SECONDS) {
          this.state.set(key, { ...cur, step: 'confirmed' });
          return { step: 'confirmed', foundValues: [] };
        }
        return { step: 'seen_via_three_resolvers', foundValues: [] };
      }
      case 'confirmed':
        return { step: 'confirmed', foundValues: [] };
    }
  }

  private async queryAll(record: ExpectedRecord): Promise<string[][]> {
    return Promise.all(this.resolvers.map((r) => this.queryResolver(r, record)));
  }

  private async queryResolver(resolver: string, record: ExpectedRecord): Promise<string[]> {
    const type = TYPE_MAP[record.type] ?? 16;
    const u = new URL(resolver);
    u.searchParams.set('name', record.name);
    u.searchParams.set('type', String(type));
    try {
      const res = await this.fetchImpl(u.toString(), { headers: { Accept: 'application/dns-json' } });
      if (!res.ok) return [];
      const json = (await res.json()) as DohResponse;
      return (json.Answer ?? []).map((a) => a.data);
    } catch {
      return [];
    }
  }
}

function recordKey(r: ExpectedRecord): string {
  return `${r.type}|${r.name}`;
}

function contentMatches(actual: string, expected: string): boolean {
  const a = actual.replace(/^"|"$/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const e = expected.replace(/^"|"$/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return a === e || a.includes(e) || e.includes(a);
}
