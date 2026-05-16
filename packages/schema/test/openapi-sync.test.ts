// Drift guard: every member of the runtime `ErrorCode` enum must appear in
// the OpenAPI document's error-code enum. Catches the case where a new code
// is added to the schema but not surfaced to API consumers via the spec.
//
// Uses a string-grep against the YAML rather than a real parser — the
// schema package has no YAML dep, and the grep is sufficient for an
// allowlist check. Each value is asserted to appear as `- <code>` (the
// YAML list-item form used in the enum block).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ErrorCode } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const openapiPath = resolve(here, '../../../openapi/polaris-email.yaml');
const openapiText = readFileSync(openapiPath, 'utf8');

describe('openapi error-code enum sync', () => {
  it.each(ErrorCode.options)('declares %s', (code) => {
    expect(openapiText).toContain(`- ${code}`);
  });

  it('covers every ErrorCode value (no silent additions)', () => {
    const missing = ErrorCode.options.filter((c) => !openapiText.includes(`- ${c}`));
    expect(missing).toEqual([]);
  });
});

// Phase C drift-guard. The runtime `MailDomain` schema gained MTA-STS +
// TLS-RPT columns from migration 0007; the spec MUST surface them so SDK
// generators and panel consumers see the same shape. Plain substring search
// against the YAML — same pattern as the ErrorCode guard above.
describe('openapi MailDomain MTA-STS / TLS-RPT sync', () => {
  const mtaStsFields = [
    'mta_sts_mode',
    'mta_sts_policy_id',
    'mta_sts_max_age',
    'mta_sts_verified_at',
    'tlsrpt_enabled',
    'tlsrpt_rua',
    'tlsrpt_verified_at',
  ];
  it.each(mtaStsFields)('declares MailDomain.%s', (field) => {
    expect(openapiText).toContain(`${field}:`);
  });

  it('declares VerifyCheck schema', () => {
    expect(openapiText).toMatch(/^\s+VerifyCheck:/m);
  });

  it('declares VerifyResponse schema', () => {
    expect(openapiText).toMatch(/^\s+VerifyResponse:/m);
  });
});
