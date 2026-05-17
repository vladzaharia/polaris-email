package provision

import (
	"context"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/cfapi"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/plan"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

// createQueueStep creates a Cloudflare Queue. DLQs are just regular
// queues with a `-dlq` name suffix — the CF API has no separate DLQ
// resource type. DLQ wiring (consumer queue → producer queue) happens
// in wranglercfg at render time, not here.
func createQueueStep(client *cfapi.Client, doc *state.Doc) func(context.Context, plan.Entry) error {
	return func(ctx context.Context, e plan.Entry) error {
		q, err := client.CreateQueue(ctx, e.Name)
		if err != nil {
			return err
		}
		doc.Queues[e.Name] = state.Resource{
			ID:         q.QueueID,
			Name:       q.QueueName,
			CreatedAt:  time.Now().UTC(),
			Discovered: false,
		}
		return nil
	}
}

// adoptQueueStep records an already-live queue into state.
func adoptQueueStep(doc *state.Doc) func(context.Context, plan.Entry) error {
	return func(_ context.Context, e plan.Entry) error {
		doc.Queues[e.Name] = state.Resource{
			ID:         e.LiveID,
			Name:       e.Name,
			CreatedAt:  time.Now().UTC(),
			Discovered: true,
		}
		return nil
	}
}
