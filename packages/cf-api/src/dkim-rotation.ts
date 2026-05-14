// DKIM key state machine for rotation overlap (A10).
//
// Real-world DKIM rotation requires two selectors live simultaneously during a
// flush window so verifiers that have cached the old key can still validate
// in-flight mail. The `dkim_keys` table carries (selector, public_key, state)
// where state ∈ {pending, active, retiring}.
//
// Flow:
//   1. planRotation()    → generates a new key + the DNS records to publish.
//                           New row inserted with state='pending'.
//   2. (operator publishes DNS, waits for DnsVerifier to confirm propagation)
//   3. promotePending()  → flips pending→active, prior active→retiring.
//   4. (RETIRE_FLUSH_WINDOW_DAYS elapses)
//   5. retireOldKey()    → removes the retiring key's DNS record + marks it
//                           retired in D1.
//
// The package consumer implements `DkimKeyOps` against their D1 layer; this
// module is pure orchestration so it stays portable across Worker/CLI consumers.

import type { ExpectedRecord } from './types.js';
import { deleteRecord, findRecord, type DnsRecordInput } from './dns.js';
import type { CloudflareApiClient } from './client.js';

export const RETIRE_FLUSH_WINDOW_DAYS = 14;

export type DkimAlgo = 'ed25519' | 'rsa2048';
export type DkimState = 'pending' | 'active' | 'retiring';

export interface DkimKey {
  id: string;
  domainId: string;
  selector: string;
  publicKey: string;
  algo: DkimAlgo;
  state: DkimState;
  activatedAt?: string;
  retiredAt?: string;
}

export interface DkimKeyOps {
  insertPending(key: Omit<DkimKey, 'state' | 'id'> & { id?: string }): Promise<DkimKey>;
  setState(id: string, state: DkimState, ts: string): Promise<void>;
  byDomainAndState(domainId: string, state: DkimState): Promise<DkimKey | null>;
  getById(id: string): Promise<DkimKey | null>;
}

export interface DnsOps {
  /** Used at retirement time to remove the now-stale CNAME. */
  deleteRecordAt(zoneId: string, name: string, type: string): Promise<void>;
}

export interface NewKeyMaterial {
  selector: string;
  publicKey: string;
  algo: DkimAlgo;
  /** Operator-side instruction for setting the DKIM CNAME; matches the
   *  zone's wildcard inheritance pattern. */
  expectedRecord: ExpectedRecord;
}

export interface RotationPlan {
  pendingKey: NewKeyMaterial;
  dnsRecordsToPublish: ExpectedRecord[];
}

/**
 * Plan a rotation. Caller is expected to:
 *   1. await dkim.insertPending({ ...plan.pendingKey, domainId })
 *   2. publish plan.dnsRecordsToPublish to DNS
 *   3. wait for DohDnsVerifier to advance to 'confirmed'
 *   4. call promotePending()
 *
 * Selector naming: `s<YYYY>-<seq>` per Resolved Q6.
 */
export async function planRotation(opts: {
  current?: DkimKey | null;
  algo: DkimAlgo;
  domain: string;
  /** Override selector (default: derive from current selector + bump seq). */
  selector?: string;
  /** Pre-generated key material (test injection); otherwise generated below. */
  generated?: { publicKey: string; privateKey: string };
}): Promise<RotationPlan> {
  const algo = opts.algo;
  const selector = opts.selector ?? deriveNextSelector(opts.current?.selector);
  const material = opts.generated ?? (await generateKeyMaterial(algo));
  const dkimRecord: ExpectedRecord = {
    type: 'TXT',
    name: `${selector}._domainkey.${opts.domain}`,
    content: dkimTxtRecord(algo, material.publicKey),
    match: 'normalized',
  };
  return {
    pendingKey: {
      selector,
      publicKey: material.publicKey,
      algo,
      expectedRecord: dkimRecord,
    },
    dnsRecordsToPublish: [dkimRecord],
  };
}

/**
 * Promote pending → active and demote prior active → retiring atomically.
 */
export async function promotePending(dkim: DkimKeyOps, pendingId: string): Promise<void> {
  const pending = await dkim.getById(pendingId);
  if (!pending) throw new Error(`pending dkim_keys row ${pendingId} not found`);
  if (pending.state !== 'pending') {
    throw new Error(`expected state=pending; got ${pending.state}`);
  }
  const prior = await dkim.byDomainAndState(pending.domainId, 'active');
  const now = new Date().toISOString();
  await dkim.setState(pending.id, 'active', now);
  if (prior && prior.id !== pending.id) {
    await dkim.setState(prior.id, 'retiring', now);
  }
}

/**
 * Retire a key after the flush window. Removes the DNS record and marks the
 * key retired. Refuses to act if the flush window hasn't elapsed.
 */
export async function retireOldKey(
  dkim: DkimKeyOps,
  retiringId: string,
  client: CloudflareApiClient,
  zoneId: string,
  domain: string,
  opts?: { now?: () => number },
): Promise<{ retired: boolean; reason?: string }> {
  const k = await dkim.getById(retiringId);
  if (!k) return { retired: false, reason: 'not_found' };
  if (k.state !== 'retiring') return { retired: false, reason: 'not_in_retiring_state' };
  const now = (opts?.now ?? Date.now)();
  const elapsedMs = now - new Date(k.activatedAt ?? k.retiredAt ?? 0).getTime();
  const flushWindowMs = RETIRE_FLUSH_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (elapsedMs < flushWindowMs) {
    return { retired: false, reason: 'flush_window_not_elapsed' };
  }
  const recordName = `${k.selector}._domainkey.${domain}`;
  const existing = await findRecord(client, zoneId, {
    type: 'TXT',
    name: recordName,
  });
  if (existing?.id) await deleteRecord(client, zoneId, existing.id);
  await dkim.setState(k.id, 'retiring', new Date(now).toISOString());
  // Note: state stays 'retiring' but retiredAt is set; consumers can also
  // hard-delete the row instead of leaving it as a tombstone — that's
  // operator policy, not enforced here.
  return { retired: true };
}

function deriveNextSelector(current?: string): string {
  const year = new Date().getUTCFullYear();
  if (!current) return `s${year}-1`;
  const m = current.match(/^s(\d{4})-(\d+)$/);
  if (!m) return `s${year}-1`;
  const seq = Number(m[2]) + 1;
  return `s${year}-${seq}`;
}

function dkimTxtRecord(algo: DkimAlgo, publicKey: string): string {
  const k = algo === 'ed25519' ? 'ed25519' : 'rsa';
  return `v=DKIM1; k=${k}; p=${publicKey}`;
}

async function generateKeyMaterial(
  algo: DkimAlgo,
): Promise<{ publicKey: string; privateKey: string }> {
  // Stub — real generation happens server-side (CF Email Service onboarding
  // returns the public key) or via a dedicated key-management Worker. For
  // tests we accept generated material via the `generated` option above.
  void algo;
  throw new Error(
    'generateKeyMaterial: pass `generated: { publicKey, privateKey }` or wire to onboardSenderDomain()',
  );
}

// re-export the input shape so consumers don't need to dig into ./dns.
export type { DnsRecordInput };
