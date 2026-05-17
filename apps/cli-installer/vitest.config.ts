// vitest config for @polaris-email/cli-installer.
//
// We run two projects:
//   * `cli-installer-workers` — pool-workers project that exercises the
//     Worker fetch handler end-to-end against the Miniflare-simulated
//     workerd runtime.
//   * `cli-installer-node`    — plain Node project for the shellcheck
//     subprocess test (which spawns `shellcheck -s sh src/install.sh`).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, defineProject } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

const here = path.dirname(fileURLToPath(import.meta.url));

const workersProject = defineProject({
  test: {
    name: 'cli-installer-workers',
    include: [path.resolve(here, 'test/worker.test.ts')],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: path.resolve(here, 'wrangler.jsonc') },
    }),
  ],
});

const nodeProject = defineProject({
  test: {
    name: 'cli-installer-node',
    include: [path.resolve(here, 'test/install.shellcheck.test.ts')],
    environment: 'node',
  },
});

export default defineConfig({
  test: {
    projects: [workersProject, nodeProject],
  },
});
