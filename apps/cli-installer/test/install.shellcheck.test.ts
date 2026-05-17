// Lints src/install.sh with shellcheck under the POSIX `sh` dialect.
//
// shellcheck is an optional dependency on developer machines but is
// installed in CI (see .github/workflows/ci.yml). When it isn't on PATH
// locally we skip the test rather than fail — CI still gates the
// invariant.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, '../src/install.sh');

function shellcheckAvailable(): boolean {
  const r = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

const available = shellcheckAvailable();
const maybe = available ? describe : describe.skip;

maybe('install.sh lints clean under shellcheck -s sh', () => {
  it('passes shellcheck with POSIX sh dialect', () => {
    const r = spawnSync('shellcheck', ['-s', 'sh', scriptPath], {
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      // Surface the output verbatim so the failure is debuggable.
      console.error('shellcheck stdout:\n' + r.stdout);
      console.error('shellcheck stderr:\n' + r.stderr);
    }
    expect(r.status).toBe(0);
  });
});

if (!available) {
  // Single placeholder test so vitest reports the skip explicitly.
  describe('install.sh shellcheck', () => {
    it.skip('shellcheck not installed locally; skipping (CI still runs it)', () => {});
  });
}
