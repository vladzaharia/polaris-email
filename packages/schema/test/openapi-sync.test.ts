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
