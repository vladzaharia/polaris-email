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
		hint := e.Extra["location_hint"]
		hours := atoi(e.Extra["object_lock_hours"])
		expiryDays := atoi(e.Extra["lifecycle_expiry_days"])
		publicDomain := e.Extra["public_domain"]

		bucket, err := client.CreateBucket(ctx, cfapi.CreateBucketInput{
			Name:         e.Name,
			Jurisdiction: jur,
			LocationHint: hint,
		})
		if err != nil {
			return err
		}

		// Apply retention. The two paths are mutually exclusive per
		// DesiredR2's contract — Object Lock for tamper-evident
		// buckets (message bodies), lifecycle expiry for
		// observability buckets (logs). CF treats the lifecycle PUT
		// as idempotent (replaces existing rules) so re-runs are safe.
		switch {
		case hours > 0:
			rule := cfapi.ObjectLockRule{
				ID:      "polaris-email-retention",
				Enabled: true,
				Condition: cfapi.ObjectLockCondition{
					Type:          "Age",
					MaxAgeSeconds: hours * 3600,
				},
			}
			if err := client.AddObjectLockRule(ctx, e.Name, jur, rule); err != nil {
				return fmt.Errorf("apply object lock: %w", err)
			}
		case expiryDays > 0:
			if err := client.AddLifecycleExpiryRule(ctx, e.Name, jur, "", expiryDays); err != nil {
				return fmt.Errorf("apply lifecycle expiry: %w", err)
			}
		}

		// Bind the public custom domain when the operator supplied one.
		// AttachR2CustomDomain is idempotent — if the binding already
		// exists from a prior run, this is a no-op.
		if publicDomain != "" {
			if err := client.AttachR2CustomDomain(ctx, e.Name, jur, cfapi.R2CustomDomain{
				Domain:  publicDomain,
				Enabled: true,
			}); err != nil {
				return fmt.Errorf("attach r2 custom domain: %w", err)
			}
		}

		doc.R2[e.Name] = state.R2Bucket{
			Name:                bucket.Name,
			Jurisdiction:        bucket.Jurisdiction,
			ObjectLockHours:     hours,
			LifecycleExpiryDays: expiryDays,
			PublicDomain:        publicDomain,
			CreatedAt:           time.Now().UTC(),
			Discovered:          false,
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
		expiryDays := atoi(e.Extra["lifecycle_expiry_days"])
		doc.R2[e.Name] = state.R2Bucket{
			Name:                e.Name,
			Jurisdiction:        jur,
			ObjectLockHours:     hours,
			LifecycleExpiryDays: expiryDays,
			PublicDomain:        e.Extra["public_domain"],
			CreatedAt:           time.Now().UTC(),
			Discovered:          true,
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
