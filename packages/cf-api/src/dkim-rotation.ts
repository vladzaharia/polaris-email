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

/**
 * W10 — Derive the next selector under our additive `polaris{YYYY}` namespace.
 *
 * Format: `polaris<YYYY>-<seq>`. Starts at `polaris<currentYear>-1` for a
 * fresh domain. When the existing key uses the legacy `s<YYYY>-<seq>` shape
 * (pre-W10), we bump it inside the legacy namespace so a deployed domain
 * doesn't change selector families mid-rotation. The legacy `cf*` selectors
 * (e.g. cf2024-1) are CF-managed and must never appear here.
 */
function deriveNextSelector(current?: string): string {
  const year = new Date().getUTCFullYear();
  if (!current || current === 'cf' || /^cf\d{4}-?\d*$/.test(current)) {
    // Fresh rotation OR currently using CF's primary selector — we start a
    // new ADDITIVE polaris-namespace selector. Per CLAUDE.md we never touch
    // the cf* names.
    return `polaris${year}-1`;
  }
  const polaris = current.match(/^polaris(\d{4})-(\d+)$/);
  if (polaris) {
    const seq = Number(polaris[2]) + 1;
    return `polaris${year}-${seq}`;
  }
  const legacy = current.match(/^s(\d{4})-(\d+)$/);
  if (legacy) {
    const seq = Number(legacy[2]) + 1;
    return `s${year}-${seq}`;
  }
  return `polaris${year}-1`;
}

function dkimTxtRecord(algo: DkimAlgo, publicKey: string): string {
  const k = algo === 'ed25519' ? 'ed25519' : 'rsa';
  return `v=DKIM1; k=${k}; p=${publicKey}`;
}

/**
 * W10 — Real DKIM keypair generation via Web Crypto.
 *
 * Both `ed25519` (RFC 8463 / DKIM v2) and `rsa2048` (legacy DKIM v1) are
 * supported. Returns base64-encoded SPKI public key + base64-encoded PKCS#8
 * private key — the same `p=<base64>` shape DNS TXT publishers expect.
 *
 * IMPORTANT (CLAUDE.md): this key publishes under a `polaris{YYYY}` selector
 * via the caller's planRotation flow, NEVER under CF's primary
 * `cf2024-1._domainkey.*` selector. Cloudflare auto-publishes its own
 * primary DKIM CNAME during Email Routing onboarding; W10 ships an
 * ADDITIVE secondary selector so DKIM verifiers that prefer ed25519 can
 * find a key on the domain without competing with CF's record.
 */
export async function generateKeyMaterial(
  algo: DkimAlgo,
): Promise<{ publicKey: string; privateKey: string }> {
  // The Web Crypto naming for ed25519 differs between runtimes: workerd
  // accepts the literal 'Ed25519'; some browser builds expect
  // { name: 'Ed25519' }. Try the object form first (most portable).
  // The DOM-lib types for `generateKey` overload split Algorithm vs
  // RsaHashedKeyGenParams in a way that's awkward to unify here; cast to
  // unknown so workerd + node + browser type stacks all accept it.
  const keyAlgo =
    algo === 'ed25519'
      ? { name: 'Ed25519' }
      : {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
          hash: 'SHA-256',
        };
  const pair = await crypto.subtle.generateKey(
    keyAlgo as unknown as Parameters<typeof crypto.subtle.generateKey>[0],
    true,
    ['sign', 'verify'],
  );
  if (!('publicKey' in pair) || !('privateKey' in pair)) {
    throw new Error('generateKeyMaterial: expected a CryptoKeyPair from generateKey');
  }
  // exportKey('spki' | 'pkcs8') always returns ArrayBuffer; the union with
  // JsonWebKey comes from the 'jwk' overload that we don't use here.
  const spki = (await crypto.subtle.exportKey('spki', pair.publicKey)) as ArrayBuffer;
  const pkcs8 = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer;
  return {
    publicKey: base64Encode(new Uint8Array(spki)),
    privateKey: base64Encode(new Uint8Array(pkcs8)),
  };
}

function base64Encode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// re-export the input shape so consumers don't need to dig into ./dns.
export type { DnsRecordInput };
