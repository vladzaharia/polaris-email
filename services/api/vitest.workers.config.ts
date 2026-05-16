import { defineProject } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineProject({
  test: {
    name: 'api-workers',
    include: [path.resolve(here, 'test/integration/*.workers.test.ts')],
    // Read D1 migrations in Node (workerd can't evaluate the
    // `@cloudflare/vitest-pool-workers` package directly); the result is
    // exposed to tests via `inject('migrations')`.
    globalSetup: [path.resolve(here, 'test/integration/global-setup.ts')],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: path.resolve(here, 'wrangler.test.jsonc') },
    }),
  ],
});
