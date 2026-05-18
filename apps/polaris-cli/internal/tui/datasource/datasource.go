// Package datasource is the read-side abstraction the TUI tabs depend on.
// One Datasource per Bubble Tea session (operator-bound HTTP client).
package datasource

import (
	"context"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
)

// Datasource exposes every read the TUI needs.
//
// Each method maps 1:1 to an existing admin route. Tabs depend on the
// interface, not the concrete impl, so tests can plug in a Fake.
type Datasource interface {
	StatusOverview(ctx context.Context, window string) (*StatsOverview, error)
	AdminStatus(ctx context.Context) (*AdminStatusCounts, error)
	AuditChainStatus(ctx context.Context) (*AuditChainStatus, error)
	AuditEntries(ctx context.Context, limit int) ([]AuditEntry, error)
	Mailboxes(ctx context.Context) ([]Mailbox, error)
	MailboxDetail(ctx context.Context, id string) (*Mailbox, error)
	Domains(ctx context.Context) ([]client.Domain, error)
	Credentials(ctx context.Context, mailboxID string) ([]Credential, error)
	CredentialStats(ctx context.Context, id, window string) (*CredStats, error)
	WebhookSubs(ctx context.Context) ([]WebhookSub, error)
	WebhookDLQ(ctx context.Context) ([]client.WebhookDLQEntry, error)
	Bridges(ctx context.Context) ([]client.Bridge, error)
	Operators(ctx context.Context) ([]client.Operator, error)
	Alerts(ctx context.Context, limit int) ([]Alert, error)
}
