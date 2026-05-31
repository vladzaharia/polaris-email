// vitest config for @polaris-mail/out.
//
// Two projects:
//   * `out-workers` — pool-workers project for Worker handler integration
//     tests (loaded from `vitest.workers.config.ts`).
//   * `out-unit`    — plain Node project for everything else, excluding
//     `.workers.test.ts` files (which only run under the workers pool).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, defineProject } from 'vitest/config';

import workersProject from './vitest.workers.config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

const nodeProject = defineProject({
  test: {
    name: 'out-unit',
    include: [path.resolve(here, 'test/**/*.test.ts')],
    exclude: [path.resolve(here, 'test/integration/*.workers.test.ts')],
    environment: 'node',
  },
});

export default defineConfig({
  test: {
    projects: [workersProject, nodeProject],
  },
});
