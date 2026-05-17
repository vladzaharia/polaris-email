package provision

import (
	"context"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/cfapi"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/plan"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

// createD1Step returns a step function that creates a D1 database via
// cfapi.CreateDatabase and records the result into doc.D1. The cfapi
// layer already handles 409/already-exists by re-listing and returning
// the existing record, so the contract here is just: call the create,
// stamp the result.
func createD1Step(client *cfapi.Client, doc *state.Doc) func(context.Context, plan.Entry) error {
	return func(ctx context.Context, e plan.Entry) error {
		db, err := client.CreateDatabase(ctx, e.Name)
		if err != nil {
			return err
		}
		doc.D1[e.Name] = state.Resource{
			ID:         db.UUID,
			Name:       db.Name,
			CreatedAt:  time.Now().UTC(),
			Discovered: false,
		}
		return nil
	}
}

// adoptD1Step records an already-live D1 database into state. No CF
// call — the live ID came from the plan's adopt path which already
// listed the account.
func adoptD1Step(doc *state.Doc) func(context.Context, plan.Entry) error {
	return func(_ context.Context, e plan.Entry) error {
		doc.D1[e.Name] = state.Resource{
			ID:         e.LiveID,
			Name:       e.Name,
			CreatedAt:  time.Now().UTC(),
			Discovered: true,
		}
		return nil
	}
}
