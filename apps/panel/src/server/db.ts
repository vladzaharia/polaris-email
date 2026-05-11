// Local sqlite-backed sessions ONLY. The source of truth for service data lives in D1
// (accessed via the upstream polaris-email-api).
import Database from 'better-sqlite3';

export interface SessionRow {
  id: string;
  subject: string;
  email: string | null;
  display_name: string | null;
  groups_json: string;
  created_at: number;
  expires_at: number;
  step_up_until: number | null;
  approver_subject: string | null; // for 2-person flows
}

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      email TEXT,
      display_name TEXT,
      groups_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      step_up_until INTEGER,
      approver_subject TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS oidc_state (
      state TEXT PRIMARY KEY,
      nonce TEXT NOT NULL,
      verifier TEXT NOT NULL,
      redirect_to TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

export function getSession(db: Database.Database, id: string): SessionRow | null {
  const row = db
    .prepare(
      'SELECT id, subject, email, display_name, groups_json, created_at, expires_at, step_up_until, approver_subject FROM sessions WHERE id = ?',
    )
    .get(id) as SessionRow | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return null;
  }
  return row;
}

export function putSession(db: Database.Database, row: SessionRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO sessions
       (id, subject, email, display_name, groups_json, created_at, expires_at, step_up_until, approver_subject)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.subject,
    row.email,
    row.display_name,
    row.groups_json,
    row.created_at,
    row.expires_at,
    row.step_up_until,
    row.approver_subject,
  );
}

export function deleteSession(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}
