// Operator auth path — post-principals-split coverage.
//
// Verifies that:
//   * api_keys reference operators directly (no principals join).
//   * Disabling an operator surfaces via the api_keys → operators lookup.
//   * Deleting an operator cascades to their api_keys via ON DELETE CASCADE.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Env } from '../../src/env.js';

interface TestEnv extends Env {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, inject('migrations'));
});

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM api_keys`).run();
  await testEnv.DB.prepare(`DELETE FROM operators`).run();
});

async function seed(opts: {
  operatorId: string;
  keyId: string;
  disabled?: boolean;
}): Promise<void> {
  const now = new Date().toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO operators
       (id, name, email, ssh_pubkey, ssh_pubkey_fp_sha256, role,
        disabled_at, created_at, updated_at)
     VALUES (?, ?, ?, 'ssh-pub', ?, 'operator', ?, ?, ?)`,
  )
    .bind(
      opts.operatorId,
      `op-${opts.operatorId}`,
      `${opts.operatorId}@test.invalid`,
      `fp-${opts.operatorId}`,
      opts.disabled ? now : null,
      now,
      now,
    )
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO api_keys
       (id, operator_id, prefix, secret_argon2id, scopes,
        rate_limit_per_min, status, created_at)
     VALUES (?, ?, 'pk_op_', '$argon2id$dummy', '["admin:read"]', 60, 'primary', ?)`,
  )
    .bind(opts.keyId, opts.operatorId, now)
    .run();
}

describe('operator auth (post-principals split)', () => {
  it('resolves api_key → operator without principals join', async () => {
    await seed({ operatorId: 'op1', keyId: '01HXKEY00000000000000000A1' });
    const row = await testEnv.DB.prepare(
      `SELECT k.id, k.operator_id, o.disabled_at
       FROM api_keys k JOIN operators o ON o.id = k.operator_id
       WHERE k.id = ?`,
    )
      .bind('01HXKEY00000000000000000A1')
      .first<{ id: string; operator_id: string; disabled_at: string | null }>();
    expect(row).toEqual({
      id: '01HXKEY00000000000000000A1',
      operator_id: 'op1',
      disabled_at: null,
    });
  });

  it('surfaces operator disabled_at via the join', async () => {
    await seed({
      operatorId: 'op2',
      keyId: '01HXKEY00000000000000000B2',
      disabled: true,
    });
    const row = await testEnv.DB.prepare(
      `SELECT o.disabled_at FROM api_keys k JOIN operators o ON o.id = k.operator_id
       WHERE k.id = ?`,
    )
      .bind('01HXKEY00000000000000000B2')
      .first<{ disabled_at: string | null }>();
    expect(row?.disabled_at).not.toBeNull();
  });

  it('cascades api_keys deletion when the operator is deleted', async () => {
    await seed({ operatorId: 'op3', keyId: '01HXKEY00000000000000000C3' });
    await testEnv.DB.prepare(`DELETE FROM operators WHERE id = ?`).bind('op3').run();
    const remaining = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE id = ?`)
      .bind('01HXKEY00000000000000000C3')
      .first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });
});
