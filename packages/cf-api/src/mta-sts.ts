// MTA-STS + TLS-RPT provisioning and verification.
//
// Background:
//   MTA-STS (RFC 8461) lets a recipient publish a TLS-required policy that
//   sending MTAs cache. The discovery flow is:
//     1. Sender resolves TXT `_mta-sts.{domain}` to learn the policy ID.
//     2. Sender fetches HTTPS `https://mta-sts.{domain}/.well-known/mta-sts.txt`
//        to read the policy itself.
//     3. Sender caches the policy by ID until the next id change.
//
// Polaris layout:
//   - DNS TXT `_mta-sts.{tenant}` — bumped to invalidate sender caches.
//   - HTTPS `mta-sts.{tenant}` — Worker custom domain pointing at
//     polaris-mail-api; the Worker route in services/api serves the policy
//     text file (Task C.9). CF Universal SSL handles the cert; we DO NOT
//     publish a CNAME for mta-sts.{tenant} ourselves.
//   - TLS-RPT TXT `_smtp._tls.{tenant}` — reports endpoint for TLS failures.

import type { CloudflareApiClient } from './client.js';
import {
  createRecord,
  deleteRecord,
  findRecord,
  updateRecord,
  type DnsRecordInput,
} from './dns.js';
import { attachCustomDomain, detachCustomDomain } from './workers-routes.js';

/**
 * Compact ISO-8601 timestamp suitable for an MTA-STS policy ID per RFC 8461
 * §3.1 (`1*32(ALPHA / DIGIT)`). Format: `YYYYMMDDTHHMMSSZ` (16 chars).
 *
 * Use the same generated ID for both the DNS TXT and the served policy text;
 * a sender will re-fetch the policy when the TXT id changes.
 */
export function generatePolicyId(d: Date = new Date()): string {
  // Take YYYY-MM-DDTHH:MM:SS from ISO string, strip delimiters → 15 chars,
  // append Z → 16 chars total. Drop milliseconds entirely.
  const iso = d.toISOString(); // e.g. '2026-05-15T12:00:00.000Z'
  const head = iso.slice(0, 19).replace(/[-:]/g, ''); // '20260515T120000'
  return `${head}Z`;
}

/**
 * DNS records that must be published when MTA-STS is enabled for a domain
 * (mode != 'none'). Returns a single TXT record; the `mta-sts.{domain}`
 * hostname is published separately as a Worker custom domain — see
 * `attachCustomDomain` in `./workers-routes.ts`.
 */
export function expectedMtaStsRecords(opts: {
  domain: string;
  policyId: string;
}): DnsRecordInput[] {
  return [
    {
      type: 'TXT',
      name: `_mta-sts.${opts.domain}`,
      content: `v=STSv1; id=${opts.policyId}`,
      comment: 'polaris-mail: MTA-STS policy id',
    },
  ];
}

/**
 * DNS record for TLS-RPT (RFC 8460). Senders POST aggregate TLS failure
 * reports to the URI in `rua=`. Multiple URIs may be comma-separated.
 */
export function expectedTlsRptRecord(opts: { domain: string; rua: string }): DnsRecordInput {
  return {
    type: 'TXT',
    name: `_smtp._tls.${opts.domain}`,
    content: `v=TLSRPTv1; rua=${opts.rua}`,
    comment: 'polaris-mail: TLS-RPT',
  };
}

export interface ProvisionMtaStsOpts {
  zoneId: string;
  domain: string;
  policyId: string;
  /** Worker script name to attach the mta-sts.{domain} custom domain to. */
  workerName: string;
}

export interface ProvisionResult {
  /** Number of records created or replaced. */
  created: number;
  /** Number of records that already matched and were not touched. */
  skipped: number;
  /** True when the Worker custom domain attach was confirmed (idempotent). */
  customDomainAttached: boolean;
}

async function upsertRecord(
  client: CloudflareApiClient,
  zoneId: string,
  record: DnsRecordInput,
): Promise<'created' | 'skipped'> {
  const existing = await findRecord(client, zoneId, { type: record.type, name: record.name });
  if (!existing) {
    await createRecord(client, zoneId, record);
    return 'created';
  }
  if (existing.content === record.content) {
    return 'skipped';
  }
  // Update in place via PATCH — preserves the record id so cached references
  // (and CF's history) remain stable across policy bumps.
  await updateRecord(client, zoneId, existing.id, record);
  return 'created';
}

async function deleteRecordsByFilter(
  client: CloudflareApiClient,
  zoneId: string,
  filter: { type: string; name: string },
): Promise<void> {
  const existing = await findRecord(client, zoneId, filter);
  if (!existing) return;
  try {
    await deleteRecord(client, zoneId, existing.id);
  } catch {
    // best-effort; let the verifier surface anything we miss.
  }
}

/**
 * Idempotently publish the MTA-STS records for a domain:
 *   1. Upsert the `_mta-sts.{domain}` TXT to the requested policyId.
 *   2. Attach `mta-sts.{domain}` as a Worker custom domain on the zone.
 *
 * Safe to call repeatedly: matching records are skipped, divergent records
 * are PATCHed, missing pieces are created.
 */
export async function provisionMtaSts(
  client: CloudflareApiClient,
  opts: ProvisionMtaStsOpts,
): Promise<ProvisionResult> {
  const expected = expectedMtaStsRecords({ domain: opts.domain, policyId: opts.policyId });
  let created = 0;
  let skipped = 0;
  for (const rec of expected) {
    const outcome = await upsertRecord(client, opts.zoneId, rec);
    if (outcome === 'created') created++;
    else skipped++;
  }
  const dom = await attachCustomDomain(client, {
    zoneId: opts.zoneId,
    hostname: `mta-sts.${opts.domain}`,
    workerName: opts.workerName,
  });
  return { created, skipped, customDomainAttached: !!dom };
}

/**
 * Remove all MTA-STS DNS records + detach the `mta-sts.{domain}` custom
 * domain. Best-effort; no-ops on records that are already gone.
 */
export async function unprovisionMtaSts(
  client: CloudflareApiClient,
  opts: { zoneId: string; domain: string },
): Promise<void> {
  // Use a placeholder policyId — we only need the record name/type for delete.
  const expected = expectedMtaStsRecords({ domain: opts.domain, policyId: 'unused' });
  for (const rec of expected) {
    await deleteRecordsByFilter(client, opts.zoneId, { type: rec.type, name: rec.name });
  }
  try {
    await detachCustomDomain(client, `mta-sts.${opts.domain}`);
  } catch {
    // best-effort
  }
}

/**
 * Idempotently publish the TLS-RPT TXT record. customDomainAttached is always
 * false for TLS-RPT (DNS-only).
 */
export async function provisionTlsRpt(
  client: CloudflareApiClient,
  opts: { zoneId: string; domain: string; rua: string },
): Promise<ProvisionResult> {
  const rec = expectedTlsRptRecord({ domain: opts.domain, rua: opts.rua });
  const outcome = await upsertRecord(client, opts.zoneId, rec);
  return {
    created: outcome === 'created' ? 1 : 0,
    skipped: outcome === 'skipped' ? 1 : 0,
    customDomainAttached: false,
  };
}

export async function unprovisionTlsRpt(
  client: CloudflareApiClient,
  opts: { zoneId: string; domain: string },
): Promise<void> {
  const rec = expectedTlsRptRecord({ domain: opts.domain, rua: 'unused' });
  await deleteRecordsByFilter(client, opts.zoneId, { type: rec.type, name: rec.name });
}

// ---------- Verifiers (C.5) ----------

export interface VerifyCheck {
  name: string;
  ok: boolean;
  expected: string;
  actual: string;
}

export interface VerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
  observedMode?: string;
}

/** Resolve TXT via DoH against 1.1.1.1; returns array of `data` strings. */
async function dohTxt(fetchImpl: typeof fetch, name: string): Promise<string[]> {
  try {
    const url = `https://1.1.1.1/dns-query?name=${encodeURIComponent(name)}&type=TXT`;
    const r = await fetchImpl(url, { headers: { accept: 'application/dns-json' } });
    if (!r.ok) return [];
    const j = (await r.json()) as { Answer?: { type: number; data: string }[] };
    return (j.Answer ?? []).map((a) => a.data);
  } catch {
    return [];
  }
}

/** Strip enclosing double-quotes from a DoH TXT data string. */
function unquoteTxt(s: string): string {
  return s.replace(/^"|"$/g, '');
}

/** Parse `v=STSv1; id=<id>` from a TXT data string. Returns null on malformed. */
function parseStsTxt(raw: string): string | null {
  const txt = unquoteTxt(raw);
  if (!/^\s*v\s*=\s*STSv1/i.test(txt)) return null;
  const m = txt.match(/id\s*=\s*([A-Za-z0-9]+)/);
  return m && m[1] ? m[1] : null;
}

/** Parse the comma-separated rua list out of a TLSRPTv1 TXT record. */
function parseTlsRptRua(raw: string): string[] {
  const txt = unquoteTxt(raw);
  if (!/^\s*v\s*=\s*TLSRPTv1/i.test(txt)) return [];
  const m = txt.match(/rua\s*=\s*([^;]+)/);
  if (!m || !m[1]) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Pull the `mode:` field out of a served MTA-STS policy file. */
function parseMtaStsPolicyMode(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^\s*mode\s*:\s*(\S+)\s*$/i);
    if (m && m[1]) return m[1].toLowerCase();
  }
  return undefined;
}

/**
 * End-to-end MTA-STS verifier:
 *   1. DoH TXT lookup of `_mta-sts.{domain}` → id check.
 *   2. HTTPS GET of `https://mta-sts.{domain}/.well-known/mta-sts.txt` with
 *      `redirect: manual`. Asserts status 200 + Content-Type starts with
 *      `text/plain` (RFC 8461 §3.2). Returns the parsed `mode:` as
 *      `observedMode` for telemetry.
 *
 * Pass `expectedPolicyId: null` to accept any non-empty id (used by the
 * admin "verify what's currently published" endpoint).
 */
export async function verifyMtaSts(
  domain: string,
  expectedPolicyId: string | null,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<VerifyResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const checks: VerifyCheck[] = [];
  let observedMode: string | undefined;

  // --- TXT id check ---
  const txt = await dohTxt(fetchImpl, `_mta-sts.${domain}`);
  const ids = txt.map(parseStsTxt).filter((x): x is string => x !== null);
  const expected = expectedPolicyId ?? '<any non-empty id>';
  let idOk = false;
  let idActual = ids.join(',') || '<none>';
  if (expectedPolicyId === null) {
    idOk = ids.length > 0;
  } else {
    idOk = ids.includes(expectedPolicyId);
  }
  checks.push({ name: 'TXT _mta-sts id', ok: idOk, expected, actual: idActual });

  // --- HTTPS policy fetch ---
  try {
    const r = await fetchImpl(`https://mta-sts.${domain}/.well-known/mta-sts.txt`, {
      redirect: 'manual',
    });
    const statusOk = r.status === 200;
    checks.push({
      name: 'https mta-sts.txt status',
      ok: statusOk,
      expected: '200',
      actual: String(r.status),
    });

    const ct = r.headers.get('content-type') ?? '';
    const ctOk = /^text\/plain\b/i.test(ct);
    checks.push({
      name: 'https mta-sts.txt content-type',
      ok: ctOk,
      expected: 'text/plain*',
      actual: ct || '<none>',
    });

    if (statusOk && ctOk) {
      const body = await r.text();
      observedMode = parseMtaStsPolicyMode(body);
    }
  } catch (err) {
    checks.push({
      name: 'https mta-sts.txt status',
      ok: false,
      expected: '200',
      actual: `fetch error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const out: VerifyResult = {
    ok: checks.every((c) => c.ok),
    checks,
  };
  if (observedMode !== undefined) out.observedMode = observedMode;
  return out;
}

/**
 * TLS-RPT verifier — DoH-only. Asserts `_smtp._tls.{domain}` TXT contains a
 * `v=TLSRPTv1; rua=<uri>` with at least one rua matching expectedRua (or any
 * non-empty rua when expectedRua is null).
 */
export async function verifyTlsRpt(
  domain: string,
  expectedRua: string | null,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<VerifyResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const checks: VerifyCheck[] = [];

  const txt = await dohTxt(fetchImpl, `_smtp._tls.${domain}`);
  const ruas = txt.flatMap(parseTlsRptRua);
  let ok = false;
  if (expectedRua === null) {
    ok = ruas.length > 0;
  } else {
    ok = ruas.includes(expectedRua);
  }
  checks.push({
    name: 'TXT _smtp._tls rua',
    ok,
    expected: expectedRua ?? '<any non-empty rua>',
    actual: ruas.join(',') || '<none>',
  });

  return { ok: checks.every((c) => c.ok), checks };
}
