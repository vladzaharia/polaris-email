// Daily: rebuild missing message ↔ policy_decision links.
//
// services/in writes the policy_decisions row before the messages row is
// committed; the back-link (messages.policy_decision_id) is written via a
// best-effort UPDATE that may fail (DB busy, late retry, etc). This cron
// finds orphaned policy_decisions rows where message_id is set but the
// matching message has policy_decision_id=NULL, and repairs the join.
import type { Env } from '../env.js';
import { recordCronRun } from './cron-runs.js';

interface OrphanRow {
  decision_id: string;
  message_id: string;
}

export async function policyBackfill(env: Env): Promise<void> {
  const start = Date.now();
  const orphans = await env.DB.prepare(
    `SELECT pd.id AS decision_id, pd.message_id AS message_id
       FROM policy_decisions pd
       JOIN messages m ON m.id = pd.message_id
      WHERE pd.message_id IS NOT NULL
        AND m.policy_decision_id IS NULL
      LIMIT 500`,
  ).all<OrphanRow>();

  let repaired = 0;
  for (const row of orphans.results ?? []) {
    const r = await env.DB.prepare(
      `UPDATE messages SET policy_decision_id = ?
        WHERE id = ? AND policy_decision_id IS NULL`,
    )
      .bind(row.decision_id, row.message_id)
      .run();
    if ((r.meta.changes ?? 0) > 0) repaired++;
  }

  await recordCronRun(env, 'policy-backfill', 'ok', Date.now() - start, `repaired=${repaired}`);
}
