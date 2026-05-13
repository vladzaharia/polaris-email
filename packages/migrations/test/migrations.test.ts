import { describe, it, expect } from 'vitest';
import {
  applyMigrations,
  splitSql,
  type MigrationsD1,
  type MigrationsD1Statement,
  type SchemaMigration,
} from '../src/index.js';

/**
 * Minimal in-memory D1 shim.
 *
 * We only need to model the subset the runner actually exercises:
 *   - CREATE TABLE IF NOT EXISTS schema_migrations (...)
 *   - SELECT version FROM schema_migrations
 *   - INSERT INTO schema_migrations (version, applied_at, sha) VALUES (?, ?, ?)
 *   - arbitrary user SQL (which we just record in `executed`).
 *
 * Anything else throws so we catch unintended runner behavior.
 */
function makeShim(initialAppliedVersions: number[] = []): {
  db: MigrationsD1;
  executed: string[];
  applied: number[];
} {
  const applied = new Set<number>(initialAppliedVersions);
  const executed: string[] = [];
  let createdTable = false;

  function makeStmt(sql: string, params: unknown[] = []): MigrationsD1Statement {
    const lower = sql.trim().toLowerCase();
    return {
      bind(...p: unknown[]) {
        return makeStmt(sql, p);
      },
      async run() {
        executed.push(sql);
        if (lower.startsWith('create table if not exists schema_migrations')) {
          createdTable = true;
          return {} as never;
        }
        if (lower.startsWith('insert into schema_migrations')) {
          if (!createdTable) throw new Error('shim: insert before create');
          applied.add(params[0] as number);
          return {} as never;
        }
        // user SQL — accept anything
        return {} as never;
      },
      async all<T>() {
        executed.push(sql);
        if (lower.startsWith('select version from schema_migrations')) {
          if (!createdTable) throw new Error('shim: select before create');
          return { results: [...applied].map((v) => ({ version: v }) as unknown as T) };
        }
        throw new Error('shim: unexpected all() ' + sql);
      },
      async first() {
        return null;
      },
    };
  }

  const db: MigrationsD1 = {
    prepare(sql: string) {
      return makeStmt(sql);
    },
    async batch(stmts) {
      const out: unknown[] = [];
      for (const s of stmts) out.push(await s.run());
      return out as never;
    },
  };

  return { db, executed, applied: [...applied] };
}

const m1: SchemaMigration = {
  version: 1,
  sha: 'aaa',
  up: 'CREATE TABLE foo (id INTEGER); CREATE INDEX idx_foo_id ON foo(id);',
};
const m2: SchemaMigration = { version: 2, sha: 'bbb', up: 'ALTER TABLE foo ADD COLUMN bar TEXT;' };
const m3: SchemaMigration = { version: 3, sha: 'ccc', up: 'CREATE TABLE baz (k TEXT PRIMARY KEY);' };

describe('applyMigrations', () => {
  it('applies all migrations on a fresh DB', async () => {
    const { db, executed } = makeShim();
    const r = await applyMigrations(db, [m1, m2, m3]);
    expect(r.applied).toBe(3);
    // Bookkeeping table created exactly once.
    const creates = executed.filter((s) =>
      s.toLowerCase().includes('create table if not exists schema_migrations'),
    );
    expect(creates.length).toBe(1);
    // schema_migrations bookkeeping insert per migration.
    const inserts = executed.filter((s) =>
      s.toLowerCase().startsWith('insert into schema_migrations'),
    );
    expect(inserts.length).toBe(3);
  });

  it('is idempotent: re-running applies 0 migrations', async () => {
    const { db } = makeShim();
    await applyMigrations(db, [m1, m2]);
    const r2 = await applyMigrations(db, [m1, m2]);
    expect(r2.applied).toBe(0);
  });

  it('skips already-applied versions and applies only new ones', async () => {
    const { db } = makeShim([1, 2]);
    const r = await applyMigrations(db, [m1, m2, m3]);
    expect(r.applied).toBe(1);
  });

  it('sorts migrations by version before applying', async () => {
    const { db, executed } = makeShim();
    await applyMigrations(db, [m3, m1, m2]);
    const inserts = executed.filter((s) =>
      s.toLowerCase().startsWith('insert into schema_migrations'),
    );
    // Three insert statements, in version order, were issued.
    expect(inserts.length).toBe(3);
  });

  it('rejects unsafe table names', async () => {
    const { db } = makeShim();
    await expect(applyMigrations(db, [m1], 'drop;--')).rejects.toThrow(/unsafe tableName/);
  });
});

describe('splitSql', () => {
  it('splits on top-level semicolons', () => {
    expect(splitSql('CREATE TABLE a (x INT); CREATE TABLE b (y INT);')).toEqual([
      'CREATE TABLE a (x INT)',
      'CREATE TABLE b (y INT)',
    ]);
  });
  it('ignores semicolons inside string literals', () => {
    expect(splitSql("INSERT INTO t VALUES ('a;b'); SELECT 1;")).toEqual([
      "INSERT INTO t VALUES ('a;b')",
      'SELECT 1',
    ]);
  });
  it('handles -- line comments', () => {
    expect(splitSql('-- a comment with ; in it\nSELECT 1;')).toEqual([
      '-- a comment with ; in it\nSELECT 1',
    ]);
  });
  it('handles trailing statement without semicolon', () => {
    expect(splitSql('SELECT 1')).toEqual(['SELECT 1']);
  });
});
