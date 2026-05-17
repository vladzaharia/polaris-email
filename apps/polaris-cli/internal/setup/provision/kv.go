package provision

import (
	"context"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/cfapi"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/plan"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

// createKVStep creates a KV namespace and records the result. The
// CF "title" is our logical name (the diff path uses the title to
// match desired ↔ live).
func createKVStep(client *cfapi.Client, doc *state.Doc) func(context.Context, plan.Entry) error {
	return func(ctx context.Context, e plan.Entry) error {
		ns, err := client.CreateNamespace(ctx, e.Name)
		if err != nil {
			return err
		}
		doc.KV[e.Name] = state.Resource{
			ID:         ns.ID,
			Name:       ns.Title,
			CreatedAt:  time.Now().UTC(),
			Discovered: false,
		}
		return nil
	}
}

// adoptKVStep records an already-live KV namespace into state.
func adoptKVStep(doc *state.Doc) func(context.Context, plan.Entry) error {
	return func(_ context.Context, e plan.Entry) error {
		doc.KV[e.Name] = state.Resource{
			ID:         e.LiveID,
			Name:       e.Name,
			CreatedAt:  time.Now().UTC(),
			Discovered: true,
		}
		return nil
	}
}
