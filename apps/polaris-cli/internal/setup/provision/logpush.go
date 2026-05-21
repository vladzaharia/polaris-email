package provision

import (
	"context"
	"fmt"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/cfapi"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

// Logpush provision is a single end-of-Apply step (no plan.Entry per
// resource) because it composes three CF objects that have to be
// created in lock-step:
//
//  1. The R2 bucket `polaris-mail-logs` — provisioned earlier by
//     createR2Step (we just reference it here).
//  2. An R2 API token scoped to that bucket. CF returns the secret
//     exactly once; we persist into state.Doc.R2Tokens immediately.
//  3. A Logpush job whose destination_conf URL embeds the token
//     credentials. Filter is set to only-error outcomes.
//
// Idempotency: each step checks for an existing resource by name
// before creating. Names are stable so a re-run of `apply` against
// the same account is a no-op.
//
// Override path: if the operator set LOGPUSH_DESTINATION_URL in
// .env.deploy, the auto-R2 path is skipped entirely (the operator
// owns their own external HTTP sink). This is decided by the caller
// passing httpSinkURL — non-empty means "skip auto-provision".

const (
	logsBucketName     = "polaris-mail-logs"
	logsTokenName      = "polaris-mail-logs"
	logsJobName        = "polaris-mail-workers"
	logsDataset        = "workers_trace_events"
	logsKeyPrefix      = "logs"
	defaultLogpushFilter = `{"where":{"and":[{"or":[{"key":"Outcome","operator":"eq","value":"exception"},{"key":"Outcome","operator":"eq","value":"exceededCpu"},{"key":"Outcome","operator":"eq","value":"unknown"}]}]}}`
)

// ProvisionLogpush wires the bucket → token → job chain. Returns nil
// when everything was idempotently skipped or successfully created.
// httpSinkURL non-empty short-circuits the whole thing.
func ProvisionLogpush(ctx context.Context, client *cfapi.Client, doc *state.Doc, httpSinkURL string) error {
	if httpSinkURL != "" {
		return provisionLogpushHTTP(ctx, client, doc, httpSinkURL)
	}
	return provisionLogpushR2(ctx, client, doc)
}

func provisionLogpushR2(ctx context.Context, client *cfapi.Client, doc *state.Doc) error {
	// The logs bucket must already be present in state — earlier
	// createR2Step is responsible. If absent, the apply pass was
	// run with a stale Desired list or the operator manually deleted
	// the bucket between phases; surface the error rather than
	// silently re-provisioning.
	bucket, ok := doc.R2[logsBucketName]
	if !ok {
		return fmt.Errorf("provision logpush: %s bucket not in state — run R2 provision phase first", logsBucketName)
	}

	// --- R2 API token (idempotent) ---
	token, err := ensureR2Token(ctx, client, doc, bucket)
	if err != nil {
		return fmt.Errorf("provision logpush: r2 token: %w", err)
	}

	// --- Logpush job (idempotent) ---
	if _, ok := doc.LogpushJobs[logsJobName]; ok {
		// State has it; trust the state record.
		return nil
	}
	existing, err := client.FindLogpushJobByName(ctx, logsJobName)
	if err != nil {
		return fmt.Errorf("provision logpush: list jobs: %w", err)
	}
	if existing != nil {
		// Adopt — CF has the job, state doesn't. Record into state.
		doc.LogpushJobs[logsJobName] = state.LogpushJob{
			ID:              existing.ID,
			Name:            existing.Name,
			Dataset:         existing.Dataset,
			DestinationConf: existing.DestinationConf,
			CreatedAt:       time.Now().UTC(),
			Discovered:      true,
		}
		return nil
	}

	destConf := cfapi.BuildR2DestinationConf(
		logsBucketName,
		logsKeyPrefix,
		client.AccountID,
		token.AccessKeyID,
		token.SecretAccessKey,
	)
	job, err := client.CreateLogpushJob(ctx, cfapi.CreateLogpushJobInput{
		Name:            logsJobName,
		Dataset:         logsDataset,
		DestinationConf: destConf,
		Filter:          defaultLogpushFilter,
		OutputOptions: map[string]any{
			"field_names": []string{
				"Event", "EventTimestampMs", "EventType", "Exceptions",
				"Logs", "Outcome", "ScriptName", "ScriptTags",
				"ScriptVersion",
			},
			"timestamp_format": "rfc3339",
		},
	})
	if err != nil {
		return fmt.Errorf("provision logpush: create job: %w", err)
	}
	doc.LogpushJobs[logsJobName] = state.LogpushJob{
		ID:              job.ID,
		Name:            job.Name,
		Dataset:         job.Dataset,
		DestinationConf: job.DestinationConf,
		CreatedAt:       time.Now().UTC(),
		Discovered:      false,
	}
	return nil
}

// ensureR2Token returns the persisted credentials for the logs bucket
// token, creating it if missing. Handles three cases:
//
//   - State has the token + secret → return as-is.
//   - State missing but CF has a token of the same name → CF refuses
//     to mint a duplicate; the secret is unrecoverable, so we delete
//     the orphan and create fresh.
//   - Neither → create + persist.
func ensureR2Token(ctx context.Context, client *cfapi.Client, doc *state.Doc, _ state.R2Bucket) (*state.R2Token, error) {
	if existing, ok := doc.R2Tokens[logsTokenName]; ok && existing.SecretAccessKey != "" {
		return &existing, nil
	}
	// State doesn't have a usable token; check for an orphan.
	if orphan, err := client.FindR2APITokenByName(ctx, logsTokenName); err == nil && orphan != nil {
		if err := client.DeleteR2APIToken(ctx, orphan.ID); err != nil {
			return nil, fmt.Errorf("delete orphan token: %w", err)
		}
	}
	// Mint a fresh token. CF returns the secret exactly once — we
	// persist immediately before doing anything else.
	created, err := client.CreateR2APIToken(ctx, cfapi.CreateR2APITokenInput{
		Name:       logsTokenName,
		Bucket:     logsBucketName,
		Permission: "object-read-write",
	})
	if err != nil {
		return nil, fmt.Errorf("create token: %w", err)
	}
	t := state.R2Token{
		ID:              created.ID,
		Name:            created.Name,
		Bucket:          logsBucketName,
		AccessKeyID:     created.AccessKeyID,
		SecretAccessKey: created.SecretAccessKey,
		CreatedAt:       time.Now().UTC(),
	}
	doc.R2Tokens[logsTokenName] = t
	return &t, nil
}

// provisionLogpushHTTP handles the operator-override path where
// LOGPUSH_DESTINATION_URL is set in .env.deploy. The job is created
// against the supplied URL (Better Stack, Honeycomb, Datadog, etc.)
// instead of R2. No bucket / token side effects.
func provisionLogpushHTTP(ctx context.Context, client *cfapi.Client, doc *state.Doc, url string) error {
	if _, ok := doc.LogpushJobs[logsJobName]; ok {
		return nil
	}
	if existing, err := client.FindLogpushJobByName(ctx, logsJobName); err == nil && existing != nil {
		doc.LogpushJobs[logsJobName] = state.LogpushJob{
			ID:              existing.ID,
			Name:            existing.Name,
			Dataset:         existing.Dataset,
			DestinationConf: existing.DestinationConf,
			CreatedAt:       time.Now().UTC(),
			Discovered:      true,
		}
		return nil
	}
	job, err := client.CreateLogpushJob(ctx, cfapi.CreateLogpushJobInput{
		Name:            logsJobName,
		Dataset:         logsDataset,
		DestinationConf: url,
		Filter:          defaultLogpushFilter,
		OutputOptions: map[string]any{
			"field_names":      []string{"Event", "EventTimestampMs", "EventType", "Exceptions", "Logs", "Outcome", "ScriptName", "ScriptTags", "ScriptVersion"},
			"timestamp_format": "rfc3339",
		},
	})
	if err != nil {
		return fmt.Errorf("provision logpush (http): %w", err)
	}
	doc.LogpushJobs[logsJobName] = state.LogpushJob{
		ID:              job.ID,
		Name:            job.Name,
		Dataset:         job.Dataset,
		DestinationConf: job.DestinationConf,
		CreatedAt:       time.Now().UTC(),
	}
	return nil
}
