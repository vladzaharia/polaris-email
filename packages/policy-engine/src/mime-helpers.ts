// Shared MIME helpers used by both the inbound and outbound policy
// dispatch glue. Previously duplicated in
// services/{in,out}/src/lib/policy-dispatch.ts.
import type { ParsedMime } from '@polaris-email/mime';

export function headersMap(parsed: ParsedMime): Record<string, string> {
  const map: Record<string, string> = {};
  for (const h of parsed.headers) {
    if (!(h.nameLc in map)) map[h.nameLc] = h.value;
  }
  return map;
}

export function rawHeadersString(parsed: ParsedMime): string {
  return parsed.headers.map((h) => `${h.name}: ${h.value}`).join('\r\n');
}

export function bodyPreviewOf(parsed: ParsedMime, maxLen = 4000): string {
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })
    .decode(parsed.body)
    .slice(0, maxLen);
}

// SPF / DKIM / DMARC verdict narrowing. The wire shape is a bare string,
// but the policy engine consumes a union — these guards drop unknown
// values to `undefined` rather than passing them through.

type SpfResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror';
const SPF: ReadonlySet<SpfResult> = new Set([
  'pass',
  'fail',
  'softfail',
  'neutral',
  'none',
  'temperror',
  'permerror',
]);

export function asSpf(value: string | undefined): SpfResult | undefined {
  return value && SPF.has(value as SpfResult) ? (value as SpfResult) : undefined;
}

type DkimResult = 'pass' | 'fail' | 'none' | 'policy' | 'neutral' | 'temperror' | 'permerror';
const DKIM: ReadonlySet<DkimResult> = new Set([
  'pass',
  'fail',
  'none',
  'policy',
  'neutral',
  'temperror',
  'permerror',
]);

export function asDkimResult(value: string | undefined): DkimResult | undefined {
  return value && DKIM.has(value as DkimResult) ? (value as DkimResult) : undefined;
}

type DmarcResult = 'pass' | 'fail' | 'none';
const DMARC: ReadonlySet<DmarcResult> = new Set(['pass', 'fail', 'none']);

export function asDmarc(value: string | undefined): DmarcResult | undefined {
  return value && DMARC.has(value as DmarcResult) ? (value as DmarcResult) : undefined;
}
