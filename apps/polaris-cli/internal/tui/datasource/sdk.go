// SDK-backed implementation of Datasource.
package datasource

import (
	"context"
	"net/url"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
)

type sdkDatasource struct {
	cli       *client.Client
	defaultTO time.Duration
}

// New wraps an existing CLI client so the TUI can call its admin routes.
// Each Bubble Tea session gets its own datasource (per-operator binding).
func New(c *client.Client) Datasource {
	return &sdkDatasource{cli: c, defaultTO: 5 * time.Second}
}

func (d *sdkDatasource) deadline(ctx context.Context) (context.Context, context.CancelFunc) {
	if _, ok := ctx.Deadline(); ok {
		return context.WithCancel(ctx)
	}
	return context.WithTimeout(ctx, d.defaultTO)
}

func (d *sdkDatasource) AdminStatus(ctx context.Context) (*AdminStatusCounts, error) {
	cctx, cancel := d.deadline(ctx)
	defer cancel()
	var out AdminStatusCounts
	if err := d.cli.DoJSON(cctx, "GET", "/v1/admin/status", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (d *sdkDatasource) StatusOverview(ctx context.Context, window string) (*StatsOverview, error) {
	cctx, cancel := d.deadline(ctx)
	defer cancel()
	q := url.Values{"window": []string{window}}
	var out StatsOverview
	if err := d.cli.DoJSON(cctx, "GET", "/v1/admin/stats/overview", q, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (d *sdkDatasource) AuditChainStatus(ctx context.Context) (*AuditChainStatus, error) {
	cctx, cancel := d.deadline(ctx)
	defer cancel()
	var out AuditChainStatus
	if err := d.cli.DoJSON(cctx, "GET", "/v1/admin/audit/chain-status", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (d *sdkDatasource) AuditEntries(ctx context.Context, limit int) ([]AuditEntry, error) {
	cctx, cancel := d.deadline(ctx)
	defer cancel()
	q := url.Values{}
	if limit > 0 {
		q.Set("limit", itoa(limit))
	}
	var resp struct {
		Data []AuditEntry `json:"data"`
	}
	if err := d.cli.DoJSON(cctx, "GET", "/v1/admin/audit/chain", q, nil, &resp); err != nil {
		return nil, err
	}
	return resp.Data, nil
}

func (d *sdkDatasource) Mailboxes(ctx context.Context) ([]Mailbox, error) {
	cctx, cancel := d.deadline(ctx)
	defer cancel()
	var resp struct {
		Data []Mailbox `json:"data"`
	}
	if err := d.cli.DoJSON(cctx, "GET", "/v1/admin/mailboxes", nil, nil, &resp); err != nil {
		return nil, err
	}
	return resp.Data, nil
}

func (d *sdkDatasource) MailboxDetail(ctx context.Context, id string) (*Mailbox, error) {
	cctx, cancel := d.deadline(ctx)
	defer cancel()
	var out Mailbox
	if err := d.cli.DoJSON(cctx, "GET", "/v1/admin/mailboxes/"+url.PathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (d *sdkDatasource) Domains(ctx context.Context) ([]client.Domain, error) {
	cctx, cancel := d.deadline(ctx)
	defer cancel()
	var resp struct {
		Data []client.Domain `json:"data"`
	}
	if err := d.cli.DoJSON(cctx, "GET", "/v1/admin/domains", nil, nil, &resp); err != nil {
		return nil, err
	}
	return resp.Data, nil
}

func (d *sdkDatasource) Credentials(ctx context.Context, mailboxID string) ([]Credential, error) {
	cctx, cancel := d.deadline(ctx)
	defer cancel()
	q := url.Values{}
	if mailboxID != "" {
		q.Set("mailbox", mailboxID)
	}
	var resp struct {
		Data []Credential `json:"data"`
	}
	if err := d.cli.DoJSON(cctx, "GET", "/v1/admin/credentials", q, nil, &resp); err != nil {
		return nil, err
	}
	return resp.Data, nil
}

func (d *sdkDatasource) CredentialStats(ctx context.Context, id, window string) (*CredStats, error) {
	cctx, cancel := d.deadline(ctx)
	defer cancel()
	q := url.Values{"window": []string{window}}
	var out CredStats
	if err := d.cli.DoJSON(cctx, "GET", "/v1/admin/credentials/"+url.PathEscape(id)+"/stats", q, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (d *sdkDatasource) WebhookSubs(ctx context.Context) ([]WebhookSub, error) {
	cctx, cancel := d.deadline(ctx)
	defer cancel()
	var resp struct {
		Data []WebhookSub `json:"data"`
	}
	if err := d.cli.DoJSON(cctx, "GET", "/v1/admin/webhook-subs", nil, nil, &resp); err != nil {
		return nil, err
	}
	return resp.Data, nil
}

func (d *sdkDatasource) WebhookDLQ(ctx context.Context) ([]client.WebhookDLQEntry, error) {
	cctx, cancel := d.deadline(ctx)
	defer cancel()
	var resp struct {
		Data []client.WebhookDLQEntry `json:"data"`
	}
	if err := d.cli.DoJSON(cctx, "GET", "/v1/admin/webhook-dlq", nil, nil, &resp); err != nil {
		return nil, err
	}
	return resp.Data, nil
}

func (d *sdkDatasource) Bridges(ctx context.Context) ([]client.Bridge, error) {
	cctx, cancel := d.deadline(ctx)
	defer cancel()
	var out []client.Bridge
	if err := d.cli.DoJSON(cctx, "GET", "/v1/admin/bridges", nil, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (d *sdkDatasource) Operators(ctx context.Context) ([]client.Operator, error) {
	cctx, cancel := d.deadline(ctx)
	defer cancel()
	var resp struct {
		Data []client.Operator `json:"data"`
	}
	if err := d.cli.DoJSON(cctx, "GET", "/v1/admin/operators", nil, nil, &resp); err != nil {
		return nil, err
	}
	return resp.Data, nil
}

func (d *sdkDatasource) Alerts(ctx context.Context, limit int) ([]Alert, error) {
	cctx, cancel := d.deadline(ctx)
	defer cancel()
	q := url.Values{}
	if limit > 0 {
		q.Set("limit", itoa(limit))
	}
	var resp struct {
		Data []Alert `json:"data"`
	}
	if err := d.cli.DoJSON(cctx, "GET", "/v1/admin/alerts", q, nil, &resp); err != nil {
		return nil, err
	}
	return resp.Data, nil
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
