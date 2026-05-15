// Package credstore is a SQLite-backed local mirror of bridge SMTP credentials.
package credstore

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	_ "modernc.org/sqlite"
)

// Credential is one bridge credential row.
type Credential struct {
	ID             string   `json:"id"`
	Username       string   `json:"username"`
	BcryptHash     string   `json:"bcrypt_hash"`
	AllowedSenders []string `json:"allowed_senders"`
	RevokedAt      *int64   `json:"revoked_at,omitempty"`
	LastUsedAt     *int64   `json:"last_used_at,omitempty"`
	MirrorVersion  int64    `json:"mirror_version"`
}

// Store is a SQLite-backed credential mirror.
type Store struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  bcrypt_hash TEXT NOT NULL,
  allowed_senders_json TEXT NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER,
  mirror_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mirror_meta (k TEXT PRIMARY KEY, v TEXT);
`

// Open opens (or creates) the SQLite file at path and runs the schema.
func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("schema: %w", err)
	}
	return &Store{db: db}, nil
}

// Close releases the underlying DB.
func (s *Store) Close() error { return s.db.Close() }

// Lookup returns the credential by username, or (nil, nil) if missing.
func (s *Store) Lookup(username string) (*Credential, error) {
	row := s.db.QueryRow(
		`SELECT id, username, bcrypt_hash, allowed_senders_json,
		        revoked_at, last_used_at, mirror_version
		   FROM credentials WHERE username = ?`, username)
	var c Credential
	var sendersJSON string
	var revoked, lastUsed sql.NullInt64
	err := row.Scan(&c.ID, &c.Username, &c.BcryptHash, &sendersJSON,
		&revoked, &lastUsed, &c.MirrorVersion)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if revoked.Valid {
		v := revoked.Int64
		c.RevokedAt = &v
	}
	if lastUsed.Valid {
		v := lastUsed.Int64
		c.LastUsedAt = &v
	}
	if sendersJSON != "" {
		_ = json.Unmarshal([]byte(sendersJSON), &c.AllowedSenders)
	}
	return &c, nil
}

// UpsertBatch inserts/updates credentials atomically.
func (s *Store) UpsertBatch(creds []Credential) error {
	if len(creds) == 0 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(`
		INSERT INTO credentials (id, username, bcrypt_hash, allowed_senders_json,
		                         revoked_at, last_used_at, mirror_version)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		  username = excluded.username,
		  bcrypt_hash = excluded.bcrypt_hash,
		  allowed_senders_json = excluded.allowed_senders_json,
		  revoked_at = excluded.revoked_at,
		  last_used_at = excluded.last_used_at,
		  mirror_version = excluded.mirror_version
	`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, c := range creds {
		sendersJSON, err := json.Marshal(c.AllowedSenders)
		if err != nil {
			return err
		}
		var revoked, lastUsed any
		if c.RevokedAt != nil {
			revoked = *c.RevokedAt
		}
		if c.LastUsedAt != nil {
			lastUsed = *c.LastUsedAt
		}
		if _, err := stmt.Exec(c.ID, c.Username, c.BcryptHash, string(sendersJSON),
			revoked, lastUsed, c.MirrorVersion); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// MarkRevoked sets revoked_at = now (epoch seconds) on a single id.
func (s *Store) MarkRevoked(id string, atEpoch int64) error {
	_, err := s.db.Exec(`UPDATE credentials SET revoked_at = ? WHERE id = ?`, atEpoch, id)
	return err
}

// DeleteByID removes a credential row.
func (s *Store) DeleteByID(id string) error {
	_, err := s.db.Exec(`DELETE FROM credentials WHERE id = ?`, id)
	return err
}

// MirrorVersion returns the high-water mark from mirror_meta, or 0.
func (s *Store) MirrorVersion() int64 {
	var v string
	err := s.db.QueryRow(`SELECT v FROM mirror_meta WHERE k = 'mirror_version'`).Scan(&v)
	if err != nil {
		return 0
	}
	n, _ := strconv.ParseInt(v, 10, 64)
	return n
}

// SetMirrorVersion persists the high-water mark.
func (s *Store) SetMirrorVersion(v int64) error {
	_, err := s.db.Exec(`INSERT INTO mirror_meta (k, v) VALUES ('mirror_version', ?)
	    ON CONFLICT(k) DO UPDATE SET v = excluded.v`, strconv.FormatInt(v, 10))
	return err
}
