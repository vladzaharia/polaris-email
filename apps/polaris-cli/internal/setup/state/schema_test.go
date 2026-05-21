package state

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMigrateSchema_V1FlatToV2Nested(t *testing.T) {
	t.Parallel()
	v1JSON := []byte(`{
		"schema_version": 1,
		"account_id": "acc-xyz",
		"d1_id": "abc-def",
		"d1_name": "polaris-mail",
		"r2_bucket": "polaris-mail-archive",
		"kv_nonce_id": "kv-nonce-1",
		"kv_revocations_id": "kv-rev-1",
		"queue_outbound_id": "q-out-1"
	}`)
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	if err := os.WriteFile(path, v1JSON, 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}

	s := Open(path)
	doc, err := s.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if doc.SchemaVersion != CurrentSchema {
		t.Errorf("want schema %d, got %d", CurrentSchema, doc.SchemaVersion)
	}
	if doc.AccountID != "acc-xyz" {
		t.Errorf("AccountID lost: got %q", doc.AccountID)
	}
	if got := doc.D1["polaris-mail"].ID; got != "abc-def" {
		t.Errorf("D1 ID: want abc-def, got %q (D1=%+v)", got, doc.D1)
	}
	if _, ok := doc.R2["polaris-mail-archive"]; !ok {
		t.Errorf("R2 bucket missing: %+v", doc.R2)
	}
	if got := doc.KV["POLARIS_NONCE_DEDUP"].ID; got != "kv-nonce-1" {
		t.Errorf("KV migration: want kv-nonce-1, got %q (KV=%+v)", got, doc.KV)
	}
	if got := doc.KV["KV_REVOCATIONS"].ID; got != "kv-rev-1" {
		t.Errorf("KV revocations: want kv-rev-1, got %q", got)
	}
	if got := doc.Queues["polaris-outbound"].ID; got != "q-out-1" {
		t.Errorf("Queue migration: got %q (Queues=%+v)", got, doc.Queues)
	}
}

func TestMigrateSchema_MissingVersionAssumesV1(t *testing.T) {
	t.Parallel()
	noVersion := []byte(`{
		"account_id": "acc-1",
		"d1_id": "db-1"
	}`)
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	if err := os.WriteFile(path, noVersion, 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	s := Open(path)
	doc, err := s.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if doc.SchemaVersion != CurrentSchema {
		t.Errorf("want schema bumped to %d, got %d", CurrentSchema, doc.SchemaVersion)
	}
	if doc.D1["polaris-mail"].ID != "db-1" {
		t.Errorf("D1 not migrated: %+v", doc.D1)
	}
}

func TestMigrateSchema_AlreadyCurrentPassesThrough(t *testing.T) {
	t.Parallel()
	currentJSON := []byte(`{
		"schema_version": 2,
		"account_id": "acc-2",
		"d1": {"polaris-mail": {"id": "db-2", "name": "polaris-mail"}}
	}`)
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	if err := os.WriteFile(path, currentJSON, 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	s := Open(path)
	doc, err := s.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if doc.SchemaVersion != CurrentSchema {
		t.Errorf("schema version garbled: %d", doc.SchemaVersion)
	}
	if doc.D1["polaris-mail"].ID != "db-2" {
		t.Errorf("D1 decode mismatch: %+v", doc.D1)
	}
}

func TestMigrateSchema_StampsCurrentOnBareEmptyMap(t *testing.T) {
	t.Parallel()
	bare := []byte(`{}`)
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	if err := os.WriteFile(path, bare, 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	s := Open(path)
	doc, err := s.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if doc.SchemaVersion != CurrentSchema {
		t.Errorf("want schema %d, got %d", CurrentSchema, doc.SchemaVersion)
	}
}
