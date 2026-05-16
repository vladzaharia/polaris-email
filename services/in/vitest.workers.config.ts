// services/in workers-pool project. Only collects `*.workers.test.ts` under
// `test/integration/`; existing Node-env unit tests are picked up by the
// root `unit` project (see vitest.config.ts).
import { defineProject } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineProject({
  test: {
    name: 'in-workers',
    include: [path.resolve(here, 'test/integration/*.workers.test.ts')],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: path.resolve(here, 'wrangler.test.jsonc') },
    }),
  ],
});
