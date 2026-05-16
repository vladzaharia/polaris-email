import { defineProject } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineProject({
  test: {
    name: 'out-workers',
    include: [path.resolve(here, 'test/integration/*.workers.test.ts')],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: path.resolve(here, 'wrangler.test.jsonc') },
    }),
  ],
});
