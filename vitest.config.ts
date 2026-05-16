// Root vitest config with project split:
//   - `unit`: Node-env per-package tests, excludes `*.workers.test.ts`.
//   - per-service `*-workers`: cloudflare:test pool-workers integration
//     tests for services/in, services/out, services/api.
//
// vitest 4 deprecates `vitest.workspace.ts` / `defineWorkspace` in favor of
// `test.projects` here (see https://vitest.dev/guide/workspace.html).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'packages/*/test/**/*.test.ts',
            'services/*/test/**/*.test.ts',
            'apps/*/test/**/*.test.ts',
          ],
          // Workers integration tests live under `test/integration/` with the
          // `*.workers.test.ts` suffix so the two suites never collide.
          exclude: ['**/test/integration/*.workers.test.ts', '**/node_modules/**', '**/dist/**'],
          environment: 'node',
        },
      },
      './services/in/vitest.workers.config.ts',
      './services/out/vitest.workers.config.ts',
      './services/api/vitest.workers.config.ts',
    ],
  },
});
