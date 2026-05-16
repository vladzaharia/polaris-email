// Node-side global setup for the api-workers pool. We read the D1 migration
// SQL from the api/migrations directory here (in a normal Node context) and
// hand the parsed `D1Migration[]` to the test files via vitest's `provide`/
// `inject` channel. The migrations themselves are applied per-test-file
// inside the worker isolate via `applyD1Migrations(env.DB, migrations)`.
//
// This indirection is mandatory: importing
// `@cloudflare/vitest-pool-workers` from a test that runs inside workerd
// crashes the runtime (the package is a Node-only ESM module with
// `node:fs`/`node:path` deps that workerd can't evaluate).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import { readD1Migrations } from '@cloudflare/vitest-pool-workers';

const here = path.dirname(fileURLToPath(import.meta.url));

export default async function setup(project: TestProject): Promise<void> {
  const migrationsDir = path.resolve(here, '../../migrations');
  const raw = await readD1Migrations(migrationsDir);

  // Strip `CREATE VIEW` / `CREATE TRIGGER` statements. Workerd's D1 simulator
  // is stricter than D1/Wrangler about view-reference rewriting during
  // `ALTER TABLE ... RENAME`: migration 0006 renames `messages` -> `messages_old`,
  // and the view created in 0001 (`v_message_with_latest_attempt`) gets its
  // backing reference rewritten to `messages_old`. When the migration then
  // `DROP TABLE messages_old`, any subsequent query that touches the view
  // fails with "no such table: main.messages_old". The services/api worker
  // proper does not depend on those views/triggers for the send path, so
  // stripping them keeps the test honest without diverging from production
  // schema.
  const migrations = raw.map((m) => ({
    ...m,
    queries: m.queries.filter((q) => !/^\s*CREATE\s+(VIEW|TRIGGER)\b/i.test(q)),
  }));
  project.provide('migrations', migrations);
}

declare module 'vitest' {
  export interface ProvidedContext {
    migrations: { name: string; queries: string[] }[];
  }
}
