// Bulk subdomain provisioning (PaaS workflow).
//
// "create one domain row per tenant subdomain so each gets isolated DKIM" is a
// per-row wizard run by default; that's a non-starter at scale. This helper
// streams progress for an N-tenant pattern under one zone, calling the
// onboard helpers idempotently.

import type { CloudflareApiClient } from './client.js';
import { onboardSenderDomain, type OnboardSenderDomainOpts } from './email-service.js';
import { setCatchAllRule } from './email-routing.js';

export interface BulkOnboardOpts {
  client: CloudflareApiClient;
  zoneId: string;
  /** Parent zone name (e.g., 'app.example.com'). */
  parentDomain: string;
  /** Iterable of generated subdomain names (e.g., ['tenant-1.app.example.com', ...]). */
  domains: Iterable<string>;
  /** Capability flags to apply to each onboarded subdomain. */
  capabilities: { inbound: boolean; outbound: boolean };
  /** Worker script bound to receive inbound when capabilities.inbound = true. */
  inboundWorkerScript?: string;
  /** Per-onboard options (selector, wildcard, bounce target, etc.). */
  perDomainOpts?: Partial<OnboardSenderDomainOpts>;
  /** Optional cap on concurrent onboards (default 4). */
  concurrency?: number;
}

export interface BulkOnboardProgress {
  domain: string;
  status: 'ok' | 'error';
  error?: string;
  /** When ok, the records published. */
  recordCount?: number;
}

/**
 * Stream onboard progress for a list of subdomains. Failures don't abort the
 * iteration — each item reports independently so the operator can re-drive
 * just the failures.
 */
export async function* bulkOnboardPattern(
  opts: BulkOnboardOpts,
): AsyncIterable<BulkOnboardProgress> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const queue = Array.from(opts.domains);

  // Inbound: enable Email Routing once + add a wildcard catch-all rule once.
  // Per the plan we use exactly ONE Email Routing rule per zone (catch-all)
  // and dispatch internally in workers/in (I8). So bulk inbound onboarding is
  // a no-op at the routing layer beyond confirming the rule exists.
  if (opts.capabilities.inbound) {
    if (opts.inboundWorkerScript) {
      try {
        await setCatchAllRule(opts.client, opts.zoneId, {
          workerScript: opts.inboundWorkerScript,
        });
      } catch (err) {
        // Treat catch-all setup failure as a per-domain error for every queued
        // entry — without it, none of these will receive inbound.
        const reason = err instanceof Error ? err.message : String(err);
        for (const d of queue) {
          yield { domain: d, status: 'error', error: `catch_all_setup: ${reason}` };
        }
        return;
      }
    }
  }

  // Outbound: per-subdomain DNS publishing. Concurrent.
  let cursor = 0;
  const inFlight: Promise<BulkOnboardProgress>[] = [];

  const next = (): Promise<BulkOnboardProgress> | null => {
    if (cursor >= queue.length) return null;
    const domain = queue[cursor++]!;
    return runOne(domain);
  };

  const runOne = async (domain: string): Promise<BulkOnboardProgress> => {
    if (!opts.capabilities.outbound) {
      return { domain, status: 'ok', recordCount: 0 };
    }
    try {
      const r = await onboardSenderDomain(opts.client, {
        zoneId: opts.zoneId,
        domain,
        ...opts.perDomainOpts,
      });
      return { domain, status: 'ok', recordCount: r.expectedRecords.length };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { domain, status: 'error', error: reason };
    }
  };

  // Prime the pump.
  for (let i = 0; i < concurrency; i++) {
    const p = next();
    if (p) inFlight.push(p);
  }

  while (inFlight.length > 0) {
    const settled = await Promise.race(inFlight.map((p, i) => p.then((v) => ({ v, i }))));
    inFlight.splice(settled.i, 1);
    yield settled.v;
    const more = next();
    if (more) inFlight.push(more);
  }
}
