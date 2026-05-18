// Package state holds the typed schema for `.deploy-state.json` and the
// atomic on-disk store + flock used by every `polaris-email setup infra`
// phase.
//
// The state file is the persistent ledger of every Cloudflare resource the
// CLI either created or adopted (rebuilt by listing live CF state). It is
// schema-versioned: writes always stamp the current version, reads migrate
// older shapes forward in-memory.
package state

import (
	"encoding/json"
	"fmt"
	"time"
)

// SchemaVersion is an integer version stamped onto every state document.
// Bump it (and add a migrator in MigrateSchema) whenever the on-disk shape
// changes in a non-additive way.
type SchemaVersion int

// CurrentSchema is the version every fresh write stamps onto the document.
const CurrentSchema SchemaVersion = 2

// Doc is the root state document persisted to .deploy-state.json.
//
// Every map is keyed by the *logical* name the CLI uses internally (e.g.
// "polaris-email" for the D1 DB, "POLARIS_API" for the api service KV).
// The mapping from logical → Cloudflare-side names is owned by the
// provision phase; the state file stores the resolved CF IDs.
type Doc struct {
	SchemaVersion SchemaVersion           `json:"schema_version"`
	CreatedAt     time.Time               `json:"created_at"`
	UpdatedAt     time.Time               `json:"updated_at"`
	AccountID     string                  `json:"account_id,omitempty"`
	Phases        map[string]Phase        `json:"phases,omitempty"`
	D1            map[string]Resource     `json:"d1,omitempty"`
	R2            map[string]R2Bucket     `json:"r2,omitempty"`
	R2Tokens      map[string]R2Token      `json:"r2_tokens,omitempty"`
	KV            map[string]Resource     `json:"kv,omitempty"`
	Queues        map[string]Resource     `json:"queues,omitempty"`
	LogpushJobs   map[string]LogpushJob   `json:"logpush_jobs,omitempty"`
	Deploys       map[string]DeployRecord `json:"deploys,omitempty"`
}

// Phase records that a named setup phase completed successfully. Used by
// `--resume` to skip phases on re-invocation.
type Phase struct {
	CompletedAt time.Time `json:"completed_at"`
	ByVersion   string    `json:"by_version,omitempty"`
}

// Resource is the generic record stamped for D1/KV/Queues — anything that
// only needs an ID + a name. Discovered=true means the record was hydrated
// by `state rebuild` from a live CF API listing rather than created by us
// (so the create timestamp is approximate / unknown).
type Resource struct {
	ID         string    `json:"id"`
	Name       string    `json:"name,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
	Discovered bool      `json:"discovered,omitempty"`
}

// R2Bucket carries the R2-specific bits (jurisdiction, object-lock window).
// We don't use the generic Resource because R2 buckets are addressed by
// name (no separate ID) and the EU jurisdiction + Object Lock retention
// are essential pieces of operator-visible state.
//
// LifecycleExpiryDays is the alternative to ObjectLockHours — when
// non-zero, the bucket has a delete-after-N-days rule rather than
// retention COMPLIANCE. The two are mutually exclusive per
// DesiredR2's contract.
type R2Bucket struct {
	Name                string    `json:"name"`
	Jurisdiction        string    `json:"jurisdiction,omitempty"`
	ObjectLockHours     int       `json:"object_lock_hours,omitempty"`
	LifecycleExpiryDays int       `json:"lifecycle_expiry_days,omitempty"`
	CreatedAt           time.Time `json:"created_at"`
	Discovered          bool      `json:"discovered,omitempty"`
}

// R2Token persists an R2 API token the CLI minted (typically for
// Logpush → R2 ingestion). CF returns the secret EXACTLY ONCE at
// creation; losing this record means the token is unrecoverable and
// the operator must re-mint via `polaris-email setup infra apply`.
//
// We store the secret in plain text in .deploy-state.json — same
// posture as the existing config.toml token store; the state file is
// 0600 and operator-owned.
type R2Token struct {
	// ID is the CF-side token identifier (used for delete during
	// rotation).
	ID string `json:"id"`
	// Name is the operator-visible token name.
	Name string `json:"name"`
	// Bucket is the bucket the token is scoped to. Logpush tokens are
	// always single-bucket.
	Bucket string `json:"bucket"`
	// AccessKeyID + SecretAccessKey are the S3-compatible creds CF
	// returns at create time. Treat the secret as sensitive.
	AccessKeyID     string    `json:"access_key_id"`
	SecretAccessKey string    `json:"secret_access_key"`
	CreatedAt       time.Time `json:"created_at"`
}

// LogpushJob records a Logpush job the CLI created. ID is CF's numeric
// job id (returned by POST /accounts/{id}/logpush/jobs). The
// DestinationConf is stored alongside so a future drift-detection pass
// can spot a job whose destination has been mutated out-of-band.
type LogpushJob struct {
	ID              int       `json:"id"`
	Name            string    `json:"name"`
	Dataset         string    `json:"dataset"`
	DestinationConf string    `json:"destination_conf"`
	CreatedAt       time.Time `json:"created_at"`
	Discovered      bool      `json:"discovered,omitempty"`
}

// DeployRecord captures the most recent successful wrangler deploy for a
// service. VersionID is the wrangler-reported version, SHA is the git SHA
// the deployment came from.
//
// PreviousVersionID is stamped by `setup infra rollback deploy <svc>`
// before it shells out to `wrangler rollback` — it records the version
// id we just rolled BACK from, so a subsequent re-roll forwards can
// find the original. Empty in the common case where no rollback has
// occurred for this service.
type DeployRecord struct {
	VersionID         string    `json:"version_id"`
	SHA               string    `json:"sha"`
	At                time.Time `json:"at"`
	PreviousVersionID string    `json:"previous_version_id,omitempty"`
}

// migrateSchema upgrades a raw JSON document to the current schema. The
// caller has already unmarshalled into a generic map so we can detect
// legacy flat-shape v1 keys.
//
// The v1 shape (pre-cleanup) had top-level keys like:
//
//	{
//	  "schema_version": 1,
//	  "d1_id": "...",
//	  "kv_nonce_id": "...",
//	  "kv_revocations_id": "...",
//	  "r2_bucket": "polaris-mail-archive",
//	  ...
//	}
//
// v2 nests resources under typed maps (`d1`, `kv`, `r2`, `queues`).
func migrateSchema(raw map[string]any) (*Doc, error) {
	versionRaw, hasVersion := raw["schema_version"]
	var version int
	if hasVersion {
		switch v := versionRaw.(type) {
		case float64:
			version = int(v)
		case int:
			version = v
		default:
			return nil, fmt.Errorf("state: schema_version has unexpected type %T", versionRaw)
		}
	}

	// Already current — round-trip through JSON to populate the typed Doc.
	if SchemaVersion(version) == CurrentSchema {
		return decodeAsDoc(raw)
	}

	// v0/v1 → v2. Build a fresh Doc and copy known fields over.
	doc := &Doc{SchemaVersion: CurrentSchema}
	if s, ok := raw["account_id"].(string); ok {
		doc.AccountID = s
	}
	if ts, ok := raw["created_at"].(string); ok {
		if parsed, err := time.Parse(time.RFC3339Nano, ts); err == nil {
			doc.CreatedAt = parsed
		}
	}
	if ts, ok := raw["updated_at"].(string); ok {
		if parsed, err := time.Parse(time.RFC3339Nano, ts); err == nil {
			doc.UpdatedAt = parsed
		}
	}

	// Flat v1 D1.
	if id, ok := raw["d1_id"].(string); ok && id != "" {
		name, _ := raw["d1_name"].(string)
		if name == "" {
			name = "polaris-email"
		}
		doc.D1 = map[string]Resource{
			name: {ID: id, Name: name, CreatedAt: doc.CreatedAt},
		}
	}

	// Flat v1 R2.
	if bucket, ok := raw["r2_bucket"].(string); ok && bucket != "" {
		doc.R2 = map[string]R2Bucket{
			bucket: {Name: bucket, CreatedAt: doc.CreatedAt},
		}
	}

	// Flat v1 KV — the bootstrap script wrote each KV id under a key
	// matching its binding name (kv_nonce_id → POLARIS_NONCE_DEDUP, etc).
	v1KVMap := map[string]string{
		"kv_nonce_id":       "POLARIS_NONCE_DEDUP",
		"kv_revocations_id": "KV_REVOCATIONS",
		"kv_settings_id":    "POLARIS_SETTINGS",
		"kv_idempotency_id": "POLARIS_IDEMPOTENCY",
		"kv_jobs_id":        "POLARIS_JOBS",
	}
	for v1Key, binding := range v1KVMap {
		if id, ok := raw[v1Key].(string); ok && id != "" {
			if doc.KV == nil {
				doc.KV = make(map[string]Resource)
			}
			doc.KV[binding] = Resource{ID: id, Name: binding, CreatedAt: doc.CreatedAt}
		}
	}

	// Flat v1 Queues.
	v1QueueMap := map[string]string{
		"queue_outbound_id":     "polaris-outbound",
		"queue_inbound_id":      "polaris-inbound",
		"queue_webhooks_id":     "polaris-webhooks",
		"queue_outbound_dlq_id": "polaris-outbound-dlq",
		"queue_webhooks_dlq_id": "polaris-webhooks-dlq",
	}
	for v1Key, qname := range v1QueueMap {
		if id, ok := raw[v1Key].(string); ok && id != "" {
			if doc.Queues == nil {
				doc.Queues = make(map[string]Resource)
			}
			doc.Queues[qname] = Resource{ID: id, Name: qname, CreatedAt: doc.CreatedAt}
		}
	}

	return doc, nil
}

func decodeAsDoc(raw map[string]any) (*Doc, error) {
	b, err := json.Marshal(raw)
	if err != nil {
		return nil, err
	}
	var d Doc
	if err := json.Unmarshal(b, &d); err != nil {
		return nil, err
	}
	if d.SchemaVersion == 0 {
		d.SchemaVersion = CurrentSchema
	}
	return &d, nil
}
