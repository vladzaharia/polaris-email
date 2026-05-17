package provision

import (
	"context"
	"fmt"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/cfapi"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/plan"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

// createR2Step creates the R2 bucket and applies the Object Lock
// retention rule. Jurisdiction comes from the plan entry's Extra map
// (set by plan.Diff from DesiredR2.Jurisdiction).
//
// Object Lock COMPLIANCE retention is *not* retroactive — if the
// bucket already existed and `AddObjectLockRule` returns an error, we
// surface it but don't fail the whole run: the operator may have
// already applied the rule manually, or the bucket may be in an
// in-progress migration. The state record is still written so the
// next `apply` run sees a Skip.
func createR2Step(client *cfapi.Client, doc *state.Doc) func(context.Context, plan.Entry) error {
	return func(ctx context.Context, e plan.Entry) error {
		jur := e.Extra["jurisdiction"]
		hours := atoi(e.Extra["object_lock_hours"])

		bucket, err := client.CreateBucket(ctx, cfapi.CreateBucketInput{
			Name:         e.Name,
			Jurisdiction: jur,
		})
		if err != nil {
			return err
		}

		// Apply Object Lock retention. CF treats the lifecycle PUT as
		// idempotent (replaces existing rules) so re-runs are safe.
		if hours > 0 {
			rule := cfapi.ObjectLockRule{
				ID:             "polaris-email-retention",
				Enabled:        true,
				RetentionHours: hours,
				RetentionMode:  "COMPLIANCE",
			}
			if err := client.AddObjectLockRule(ctx, e.Name, jur, rule); err != nil {
				return fmt.Errorf("apply object lock: %w", err)
			}
		}

		doc.R2[e.Name] = state.R2Bucket{
			Name:            bucket.Name,
			Jurisdiction:    bucket.Jurisdiction,
			ObjectLockHours: hours,
			CreatedAt:       time.Now().UTC(),
			Discovered:      false,
		}
		return nil
	}
}

// adoptR2Step records an already-live R2 bucket. The object-lock
// retention window is *not* re-applied on adopt — adoption assumes
// the operator has already configured the bucket; we just bring it
// under the CLI's ledger.
func adoptR2Step(doc *state.Doc) func(context.Context, plan.Entry) error {
	return func(_ context.Context, e plan.Entry) error {
		jur := e.Extra["live_jurisdiction"]
		if jur == "" {
			jur = e.Extra["jurisdiction"]
		}
		hours := atoi(e.Extra["object_lock_hours"])
		doc.R2[e.Name] = state.R2Bucket{
			Name:            e.Name,
			Jurisdiction:    jur,
			ObjectLockHours: hours,
			CreatedAt:       time.Now().UTC(),
			Discovered:      true,
		}
		return nil
	}
}

// atoi is a small, error-swallowing strconv.Atoi. Returns 0 on parse
// failure — only used for Extra-map ints we control on the producing
// side, so failure here is a programming error rather than user input.
func atoi(s string) int {
	if s == "" {
		return 0
	}
	n := 0
	neg := false
	for i, ch := range s {
		if i == 0 && ch == '-' {
			neg = true
			continue
		}
		if ch < '0' || ch > '9' {
			return 0
		}
		n = n*10 + int(ch-'0')
	}
	if neg {
		return -n
	}
	return n
}
