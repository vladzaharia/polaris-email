// vitest config for @polaris-mail/api.
//
// Two projects:
//   * `api-workers` — pool-workers project that exercises route handlers
//     against the Miniflare-simulated workerd runtime. Loaded from
//     `vitest.workers.config.ts` so it can be edited independently.
//   * `api-unit`    — plain Node project for everything else under
//     `test/**/*.test.ts`, excluding the `.workers.test.ts` integration
//     suite (which only runs under the workers pool).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, defineProject } from 'vitest/config';

import workersProject from './vitest.workers.config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

const nodeProject = defineProject({
  test: {
    name: 'api-unit',
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
