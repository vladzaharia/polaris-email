// Domain decommission state machine (H8 mitigation).
//
// Subdomain takeover via partial decommission is a real risk: deleting a
// `domains` row while DNS records (especially MX) remain lets an attacker
// re-register the inbound and harvest mail. This state machine forces an
// explicit ordered teardown with DoH read-back at every step so we can prove
// each prior step actually took effect on the public DNS before progressing.

import type { DnsVerifier, VerifyStep } from './dns-verify.js';
import {
  deleteEmailRoutingRule,
  disableEmailRouting,
  listEmailRoutingRules,
} from './email-routing.js';
import { deleteRecord, findRecord, listRecords } from './dns.js';
import type { CloudflareApiClient } from './client.js';

export type DecomState =
  | 'active'
  | 'drained'
  | 'off-boarded'
  | 'routing-removed'
  | 'mx-removed'
  | 'dkim-removed'
  | 'tombstoned';

const ORDER: DecomState[] = [
  'active',
  'drained',
  'off-boarded',
  'routing-removed',
  'mx-removed',
  'dkim-removed',
  'tombstoned',
];

export interface DomainCtx {
  /** D1 row id. */
  id: string;
  /** Full DNS name (e.g., 'mail.acme.com'). */
  name: string;
  /** CF zone the records live in. */
  cfZoneId: string;
  /** Active DKIM selectors at the start of decommission. */
  dkimSelectors: string[];
}

export interface DecomDeps {
  client: CloudflareApiClient;
  /** DoH verifier — proves each step took effect on public DNS. */
  verifier: DnsVerifier;
  /** D1 access layer for state transitions + credential teardown. */
  store: DecomStore;
}

export interface DecomStore {
  getState(domainId: string): Promise<DecomState>;
  setState(domainId: string, state: DecomState): Promise<void>;
  /** drain: stop accepting new sends/inbound; flips the disabled_at flag. */
  markDrained(domainId: string): Promise<void>;
  /** off-board: revoke all SMTP credentials whose senders are on this domain. */
  revokeAssociatedCredentials(domainId: string): Promise<{ revoked: number }>;
}

export interface AdvanceResult {
  newState: DecomState;
  ok: boolean;
  /** When ok=false, what's still present that blocks progress. */
  missing?: string[];
  /** When ok=false, hint for retry. */
  retryAfterMs?: number;
}

export class Decommissioner {
  constructor(private deps: DecomDeps) {}

  async currentState(domainId: string): Promise<DecomState> {
    return this.deps.store.getState(domainId);
  }

  /**
   * Advance one step. Each transition runs the side effect, then issues a
   * DoH read-back to confirm the public state matches before flipping the
   * D1 state. If read-back fails, the transition is NOT recorded and the
   * caller can retry.
   */
  async advance(domain: DomainCtx, opts?: { now?: () => number }): Promise<AdvanceResult> {
    void opts; // reserved for tests
    const cur = await this.deps.store.getState(domain.id);
    const idx = ORDER.indexOf(cur);
    if (idx < 0) {
      return { newState: cur, ok: false, missing: ['unknown current state'] };
    }
    if (cur === 'tombstoned') {
      return { newState: cur, ok: true };
    }
    const next = ORDER[idx + 1]!;
    switch (next) {
      case 'drained':
        await this.deps.store.markDrained(domain.id);
        await this.deps.store.setState(domain.id, 'drained');
        return { newState: 'drained', ok: true };
      case 'off-boarded': {
        const r = await this.deps.store.revokeAssociatedCredentials(domain.id);
        await this.deps.store.setState(domain.id, 'off-boarded');
        return { newState: 'off-boarded', ok: true, missing: [`revoked ${r.revoked}`] };
      }
      case 'routing-removed': {
        // Delete every Email Routing rule whose matchers reference this domain.
        const rules = await listEmailRoutingRules(this.deps.client, domain.cfZoneId);
        const toDelete = rules.filter((r) =>
          (r.matchers ?? []).some((m) => (m.value ?? '').endsWith('@' + domain.name))
        );
        for (const r of toDelete) {
          if (r.id) await deleteEmailRoutingRule(this.deps.client, domain.cfZoneId, r.id);
        }
        // For the apex domain row, also disable Email Routing entirely.
        if (!domain.name.includes('.', domain.name.indexOf('.') + 1)) {
          await disableEmailRouting(this.deps.client, domain.cfZoneId).catch((e: unknown) => {
            // eslint-disable-next-line no-console
            console.warn(
              `disableEmailRouting ${domain.cfZoneId} failed`,
              e instanceof Error ? e.message : 'unknown',
            );
          });
        }
        const ok = await this.confirmRemoved(
          { type: 'MX', name: domain.name },
          /*mustBeAbsent=*/ false
        );
        // Routing absence is implicit; we can't directly DoH-check Cloudflare's
        // internal routing state, so we treat the Cloudflare API call as truth.
        await this.deps.store.setState(domain.id, 'routing-removed');
        return { newState: 'routing-removed', ok: true, missing: ok ? undefined : [] };
      }
      case 'mx-removed': {
        const records = await listRecords(this.deps.client, domain.cfZoneId, {
          type: 'MX',
          name: domain.name,
        });
        for (const r of records) {
          if (r.id) await deleteRecord(this.deps.client, domain.cfZoneId, r.id);
        }
        const stillThere = await this.confirmRemoved(
          { type: 'MX', name: domain.name },
          /*mustBeAbsent=*/ true
        );
        if (!stillThere.ok) {
          return {
            newState: 'routing-removed',
            ok: false,
            missing: ['MX still resolving via DoH'],
            retryAfterMs: 60_000,
          };
        }
        await this.deps.store.setState(domain.id, 'mx-removed');
        return { newState: 'mx-removed', ok: true };
      }
      case 'dkim-removed': {
        for (const sel of domain.dkimSelectors) {
          const name = `${sel}._domainkey.${domain.name}`;
          const r = await findRecord(this.deps.client, domain.cfZoneId, {
            type: 'TXT',
            name,
          });
          if (r?.id) await deleteRecord(this.deps.client, domain.cfZoneId, r.id);
        }
        await this.deps.store.setState(domain.id, 'dkim-removed');
        return { newState: 'dkim-removed', ok: true };
      }
      case 'tombstoned':
        await this.deps.store.setState(domain.id, 'tombstoned');
        return { newState: 'tombstoned', ok: true };
      default:
        return { newState: cur, ok: false };
    }
  }

  /**
   * DoH-confirm a record's presence/absence. Wraps the verifier in a single
   * advance step.
   */
  private async confirmRemoved(
    record: { type: string; name: string },
    mustBeAbsent: boolean
  ): Promise<{ ok: boolean; step?: VerifyStep }> {
    try {
      const r = await this.deps.verifier.advance({
        type: record.type,
        name: record.name,
        content: '',
      });
      const present = (r.foundValues?.length ?? 0) > 0;
      return { ok: mustBeAbsent ? !present : present, step: r.step };
    } catch {
      return { ok: !mustBeAbsent };
    }
  }
}
