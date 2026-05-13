/**
 * Custom D1 schema-migrations runner.
 *
 * Why custom (and not `wrangler d1 migrations apply`)?
 *   - The sharded architecture (control / messages-YYYY-MM / audit) creates new
 *     databases at runtime (a fresh per-month messages shard is provisioned
 *     each month). Wrangler's CLI-driven flow can't apply migrations to a DB
 *     that doesn't exist at deploy time.
 *   - We want migration application to be idempotent and observable from
 *     inside the Worker (audit log entry per applied version).
 *
 * Usage:
 *   import { applyMigrations } from '@polaris-email/migrations';
 *   import controlMigrations from './control-migrations.js';
 *   await applyMigrations(env.CONTROL_DB, controlMigrations);
 */

export interface SchemaMigration {
  /** Monotonically-increasing integer version. Must be unique within a DB. */
  version: number;
  /** SHA of the migration source (any algo); recorded for drift detection. */
  sha: string;
  /** SQL to apply. May contain multiple statements separated by `;`. */
  up: string;
}

export interface ApplyResult {
  applied: number;
}

/**
 * Minimal subset of the D1 surface we use. Kept narrow so the runner is easy
 * to test with an in-memory shim.
 */
export interface MigrationsD1 {
  prepare(sql: string): MigrationsD1Statement;
  batch<T = unknown>(statements: MigrationsD1Statement[]): Promise<T[]>;
}
export interface MigrationsD1Statement {
  bind(...params: unknown[]): MigrationsD1Statement;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run<T = unknown>(): Promise<T>;
  first<T = unknown>(): Promise<T | null>;
}

/**
 * Apply any unapplied migrations from `migrations` to `db`. Migrations are
 * sorted by `version` ascending. Each unapplied migration is executed inside a
 * single `db.batch()` call together with the schema_migrations bookkeeping
 * insert, so the migration either fully applies or not at all.
 */
export async function applyMigrations(
  db: MigrationsD1,
  migrations: SchemaMigration[],
  tableName = 'schema_migrations',
): Promise<ApplyResult> {
  if (!isSafeIdentifier(tableName)) {
    throw new Error(`applyMigrations: unsafe tableName ${JSON.stringify(tableName)}`);
  }

  // 1. Ensure bookkeeping table exists.
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ${tableName} (
         version    INTEGER PRIMARY KEY,
         applied_at TEXT NOT NULL,
         sha        TEXT NOT NULL
       )`,
    )
    .run();

  // 2. Read applied versions.
  const appliedRows = await db
    .prepare(`SELECT version FROM ${tableName}`)
    .all<{ version: number }>();
  const appliedVersions = new Set(appliedRows.results.map((r) => r.version));

  // 3. Sort and apply unapplied.
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  let applied = 0;
  for (const m of sorted) {
    if (appliedVersions.has(m.version)) continue;

    const stmts: MigrationsD1Statement[] = splitSql(m.up).map((s) => db.prepare(s));
    stmts.push(
      db
        .prepare(`INSERT INTO ${tableName} (version, applied_at, sha) VALUES (?, ?, ?)`)
        .bind(m.version, new Date().toISOString(), m.sha),
    );
    await db.batch(stmts);
    applied++;
  }

  return { applied };
}

function isSafeIdentifier(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

/**
 * Split a SQL blob on top-level semicolons. Keeps it simple: ignores `;`
 * inside single-quoted strings and `--` line comments. Sufficient for our
 * migration files (no triggers/blocks containing `;`).
 */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    // Line comment
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        buf += sql[i]!;
        i++;
      }
      continue;
    }
    // Single-quoted string (with '' escape)
    if (ch === "'") {
      buf += ch;
      i++;
      while (i < sql.length) {
        const c = sql[i]!;
        buf += c;
        i++;
        if (c === "'") {
          if (sql[i] === "'") {
            buf += sql[i]!;
            i++;
            continue;
          }
          break;
        }
      }
      continue;
    }
    if (ch === ';') {
      const trimmed = buf.trim();
      if (trimmed.length) out.push(trimmed);
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  const tail = buf.trim();
  if (tail.length) out.push(tail);
  return out;
}
