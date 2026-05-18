package cfapi

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
)

// LogpushJob is the response shape from /accounts/{id}/logpush/jobs.
// destination_conf is the URL form CF uses to encode every destination
// kind: `r2://...` for R2, `https://...` for HTTP, `s3://...` etc.
type LogpushJob struct {
	ID              int    `json:"id"`
	Name            string `json:"name"`
	Dataset         string `json:"dataset"`
	DestinationConf string `json:"destination_conf"`
	Enabled         bool   `json:"enabled"`
	Filter          string `json:"filter,omitempty"`
	Frequency       string `json:"frequency,omitempty"`
}

type logpushJobListResp struct {
	Jobs []LogpushJob `json:"jobs"`
}

// CreateLogpushJobInput configures a new Logpush job.
//
// Dataset is one of CF's documented dataset names — `workers_trace_events`
// for Worker execution logs (polaris-email's primary use case),
// `http_requests` for HTTP edge logs, etc.
//
// DestinationConf is the URL the dataset is shipped to. R2 form:
//   `r2://<bucket>/<prefix>?account-id=<acct>&access-key-id=<id>&secret-access-key=<sec>`
// HTTP form:
//   `https://...` (token in query string)
//
// Filter is the optional JSON filter expression that limits which
// events are forwarded; defaults to empty (all events).
//
// OutputOptions controls field selection + timestamp format. We pass
// it through as-is; the provision layer constructs a sensible default.
type CreateLogpushJobInput struct {
	Name            string
	Dataset         string
	DestinationConf string
	Filter          string
	OutputOptions   map[string]any
}

// CreateLogpushJob creates a new Logpush job. Returns the job's ID for
// state persistence; idempotency is the caller's responsibility (use
// ListLogpushJobs first).
func (c *Client) CreateLogpushJob(ctx context.Context, in CreateLogpushJobInput) (*LogpushJob, error) {
	if in.Name == "" {
		return nil, fmt.Errorf("cfapi: logpush job name required")
	}
	if in.Dataset == "" {
		return nil, fmt.Errorf("cfapi: logpush dataset required")
	}
	if in.DestinationConf == "" {
		return nil, fmt.Errorf("cfapi: logpush destination_conf required")
	}
	body := map[string]any{
		"name":             in.Name,
		"dataset":          in.Dataset,
		"destination_conf": in.DestinationConf,
		"enabled":          true,
	}
	if in.Filter != "" {
		body["filter"] = in.Filter
	}
	if in.OutputOptions != nil {
		body["output_options"] = in.OutputOptions
	}
	var resp LogpushJob
	if err := c.do(ctx, http.MethodPost, c.accountPath("/logpush/jobs"), body, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// ListLogpushJobs returns every Logpush job on the account. Used by the
// provision step's idempotency check.
func (c *Client) ListLogpushJobs(ctx context.Context) ([]LogpushJob, error) {
	var resp logpushJobListResp
	if err := c.do(ctx, http.MethodGet, c.accountPath("/logpush/jobs"), nil, &resp); err != nil {
		return nil, err
	}
	return resp.Jobs, nil
}

// FindLogpushJobByName returns the job with the given name, or nil.
func (c *Client) FindLogpushJobByName(ctx context.Context, name string) (*LogpushJob, error) {
	jobs, err := c.ListLogpushJobs(ctx)
	if err != nil {
		return nil, err
	}
	for i, j := range jobs {
		if j.Name == name {
			return &jobs[i], nil
		}
	}
	return nil, nil
}

// DeleteLogpushJob removes a job by ID. Used for cleanup during
// provision when we need to recreate a job whose destination_conf has
// drifted.
func (c *Client) DeleteLogpushJob(ctx context.Context, id int) error {
	if id <= 0 {
		return fmt.Errorf("cfapi: logpush job id required")
	}
	return c.do(ctx, http.MethodDelete, c.accountPath("/logpush/jobs/"+strconv.Itoa(id)), nil, nil)
}

// BuildR2DestinationConf assembles the R2-format destination_conf URL
// CF Logpush expects. The credentials are embedded in the URL as
// query params — there is no separate "credentials" field on the
// Logpush job API. Hostnames + paths are URL-escaped to prevent
// injection via bucket / prefix names (which we control, but the
// escaping is cheap insurance).
func BuildR2DestinationConf(bucket, prefix, accountID, accessKeyID, secretAccessKey string) string {
	q := url.Values{}
	q.Set("account-id", accountID)
	q.Set("access-key-id", accessKeyID)
	q.Set("secret-access-key", secretAccessKey)
	return fmt.Sprintf("r2://%s/%s?%s",
		url.PathEscape(bucket),
		url.PathEscape(prefix),
		q.Encode(),
	)
}
