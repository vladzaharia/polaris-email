package preflight

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// B2Config captures inputs for the anchor S3 / Backblaze B2 preflight
// probe. If Endpoint is empty (the operator hasn't configured anchors
// yet), the check returns a single warn — anchors are an optional
// subsystem.
//
// The plan calls out two acceptable strategies: a full SigV4-signed
// HEAD bucket + GetBucketObjectLockConfiguration, or a bare HEAD over
// the public endpoint to confirm the bucket exists. We ship the
// lighter-weight version here — a bare HEAD on the bucket URL — and
// leave the full lock-config check as a follow-up.
//
// Backblaze's S3-compatible endpoint returns 401 for unauthenticated
// HEADs on private buckets, which is still a useful "endpoint reachable"
// signal. A connection refused / DNS failure is a real FAIL.
type B2Config struct {
	Endpoint   string
	Bucket     string
	HTTPClient httpDoer
}

// CheckB2Anchor is the optional anchor-bucket reachability probe. It
// runs only when ANCHOR_S3_ENDPOINT + ANCHOR_S3_BUCKET are both set.
// The full SigV4 Object-Lock-mode probe is deliberately out of scope
// for PR 2 — a follow-up PR can promote this to a hard check.
func CheckB2Anchor(cfg B2Config) Check {
	return Check{
		Name:        "anchor bucket reachable",
		Required:    false,
		Description: "if ANCHOR_S3_ENDPOINT is configured, HEAD-probe the bucket URL",
		Run: func(ctx context.Context) Result {
			if cfg.Endpoint == "" || cfg.Bucket == "" {
				return warn("ANCHOR_S3_ENDPOINT/BUCKET unset — skipping anchor probe",
					"set ANCHOR_S3_* in .env.deploy if you have a Backblaze B2 bucket")
			}

			endpoint := strings.TrimRight(cfg.Endpoint, "/")
			// Path-style addressing: <endpoint>/<bucket>. B2's S3 API
			// supports both, so the simpler form keeps the probe robust.
			bucketURL := fmt.Sprintf("%s/%s", endpoint, cfg.Bucket)

			client := cfg.HTTPClient
			if client == nil {
				client = &http.Client{Timeout: 10 * time.Second}
			}

			req, err := http.NewRequestWithContext(ctx, http.MethodHead, bucketURL, nil)
			if err != nil {
				return fail(fmt.Sprintf("build request: %v", err),
					"verify ANCHOR_S3_ENDPOINT is a valid URL")
			}
			resp, err := client.Do(req)
			if err != nil {
				return fail(fmt.Sprintf("reach %s: %v", endpoint, err),
					"verify network connectivity and ANCHOR_S3_ENDPOINT")
			}
			defer resp.Body.Close()

			switch resp.StatusCode {
			case http.StatusOK:
				return pass(fmt.Sprintf("%s reachable (200)", cfg.Bucket))
			case http.StatusUnauthorized, http.StatusForbidden:
				// Expected for a private bucket without SigV4 — the
				// endpoint is reachable, the bucket name is valid.
				return pass(fmt.Sprintf("%s reachable (%d, expected for private bucket)",
					cfg.Bucket, resp.StatusCode))
			case http.StatusNotFound:
				return fail(fmt.Sprintf("bucket %q returned 404", cfg.Bucket),
					"verify ANCHOR_S3_BUCKET matches an existing Backblaze B2 bucket")
			default:
				return warn(fmt.Sprintf("HEAD %s returned HTTP %d", bucketURL, resp.StatusCode), "")
			}
		},
	}
}
