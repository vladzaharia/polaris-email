// Package genesis implements PR 7's bootstrap genesis-seal flow.
//
// The seal is the last phase of the cold-start runner. Once the
// Worker fleet is deployed and POLARIS_SECRET_A is live in every
// service's wrangler secrets, this package signs the canonical
// `POST /v1/admin/bootstrap` request with the freshly seeded secret,
// captures the minted admin key, and polls the new
// `GET /v1/admin/setup/webauthn/<code>` endpoint until the operator
// completes the WebAuthn ceremony in their browser.
//
// Master secret (POLARIS_SECRET_A) flows through this package by value
// only; it is never written to disk. The admin key — which IS written,
// to .bootstrap-output.json mode 0600 — is the operator's day-to-day
// admin credential and follows the same convention bin/bootstrap.sh
// used before this PR.
package genesis

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	polarissdk "github.com/polaris-email/polaris-sdk-go"
)

// DefaultBootstrapOutputPath mirrors bin/_lib.sh::BOOTSTRAP_OUTPUT — the
// JSON blob containing the admin key id + secret. Smoke uses the same
// constant when it loads the admin client.
const DefaultBootstrapOutputPath = ".bootstrap-output.json"

// DefaultPollInterval is how often the CLI hits the webauthn poll
// endpoint while waiting for the browser-side ceremony to complete.
const DefaultPollInterval = 2 * time.Second

// DefaultPollTimeout caps how long the CLI is willing to wait for the
// operator to finish the ceremony. Mirrors the server-side TTL on the
// setup code (5 minutes) — beyond that the code expires server-side
// anyway.
const DefaultPollTimeout = 5 * time.Minute

// SealOptions tunes the seal flow. Zero values are sensible defaults.
type SealOptions struct {
	// APIBaseURL is the public URL of polaris-email-api (e.g.
	// "https://polaris-email-api.example.com"). Required.
	APIBaseURL string

	// MasterSecret is POLARIS_SECRET_A's plaintext, passed through the
	// in-memory secrets map from the seed phase. NEVER stash this to
	// disk; the seal flow reads it once to sign the bootstrap POST.
	MasterSecret string

	// IdempotencyKey lets a retry pick up the prior response when the
	// network died between POST and the on-disk capture. The same key
	// must be reused on the retry. Empty disables idempotent replay.
	IdempotencyKey string

	// WebAuthnToken is the operator's WebAuthn-stamped JWT (headless
	// path). When set, the seal flow skips the browser-open + poll
	// loop entirely and submits a /complete to the server with this
	// token in the body. Used by CI / docs runs.
	WebAuthnToken string

	// NoBrowser disables the exec.Command("open"|"xdg-open"|"start")
	// invocation that pops the operator's browser. Operators can pass
	// this when working over SSH or in a containerised dev loop —
	// the enrolment URL still prints to stdout.
	NoBrowser bool

	// OutputPath is where the admin key gets written. Defaults to
	// DefaultBootstrapOutputPath in the current working directory.
	OutputPath string

	// PollInterval / PollTimeout override the defaults above. Tests
	// shorten these dramatically.
	PollInterval time.Duration
	PollTimeout  time.Duration

	// HTTPClient lets tests inject a fake transport. nil means
	// http.DefaultClient with a 30s timeout.
	HTTPClient *http.Client

	// BrowserOpener lets tests inject a fake "open this URL" hook.
	// nil means the real os.exec path (or a no-op when NoBrowser=true).
	BrowserOpener func(url string) error

	// Out is where status messages get written. nil means os.Stdout.
	Out io.Writer
}

// SealResult is what Seal returns on success.
type SealResult struct {
	// AdminKeyID is the ULID of the freshly minted admin key.
	AdminKeyID string `json:"admin_key_id"`

	// AdminKeySecret is the plaintext HMAC secret. The .bootstrap-output.json
	// file on disk carries the same value.
	AdminKeySecret string `json:"admin_key_secret"`

	// MailboxID is the canonical operator mailbox id.
	MailboxID string `json:"mailbox_id"`

	// WebAuthnEnrolled is true when the operator completed the ceremony
	// before the poll loop timed out. False on headless paths that
	// skipped the loop entirely (WebAuthnToken set).
	WebAuthnEnrolled bool `json:"webauthn_enrolled"`

	// WebAuthnEnrolURL is the URL printed to the operator (and opened
	// in their browser when a TTY is present). Captured here so the
	// caller can render it in TUI history.
	WebAuthnEnrolURL string `json:"webauthn_enrol_url,omitempty"`
}

// bootstrapResponse is the server's response shape. Mirrors the typed
// body in services/api/src/routes/bootstrap.ts.
type bootstrapResponse struct {
	AdminKeyID       string `json:"admin_key_id"`
	AdminKeySecret   string `json:"admin_key_secret"`
	MailboxID        string `json:"mailbox_id"`
	SetupCode        string `json:"setup_code"`
	WebAuthnEnrolURL string `json:"webauthn_enrol_url"`
}

// pollResponse mirrors GET /v1/admin/setup/webauthn/<code>.
type pollResponse struct {
	Status string `json:"status"`
}

// Seal drives the end-to-end genesis-seal flow. Steps:
//
//  1. POST /v1/admin/bootstrap signed with opts.MasterSecret.
//  2. If already_bootstrapped + opts.IdempotencyKey unset → return
//     the typed AlreadyBootstrappedError so the caller can decide.
//  3. Otherwise capture the minted admin key + setup code.
//  4. Write .bootstrap-output.json mode 0600.
//  5. Open the operator's browser to the enrolment URL (or print it).
//  6. Poll the setup code until status=complete (or timeout/expire).
//  7. Return the SealResult.
//
// On the WebAuthnToken headless path, steps 5-6 are skipped; we POST
// .../complete with the token in the body so the audit trail still
// records the enrolment.
func Seal(ctx context.Context, opts SealOptions) (*SealResult, error) {
	if err := opts.validate(); err != nil {
		return nil, err
	}
	out := opts.outOrStderr()
	httpc := opts.httpClient()

	// 1) Bootstrap POST.
	body, status, err := postBootstrap(ctx, httpc, opts)
	if err != nil {
		return nil, err
	}
	if status == http.StatusConflict {
		return nil, decodeAlreadyBootstrapped(body)
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("genesis: bootstrap returned HTTP %d: %s", status, strings.TrimSpace(string(body)))
	}
	var resp bootstrapResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("genesis: decode bootstrap response: %w", err)
	}
	if resp.AdminKeyID == "" || resp.AdminKeySecret == "" {
		return nil, fmt.Errorf("genesis: bootstrap response missing admin_key_id/admin_key_secret")
	}

	// 4) Persist admin key first. If the WebAuthn ceremony times out
	// the operator still has a usable admin key; the seal is incomplete
	// but rerunning the same Idempotency-Key will replay the cached
	// response without re-minting.
	if err := writeBootstrapOutput(opts.outputPath(), resp); err != nil {
		return nil, fmt.Errorf("genesis: write bootstrap output: %w", err)
	}
	fmt.Fprintf(out, "genesis: wrote admin key to %s\n", opts.outputPath())

	result := &SealResult{
		AdminKeyID:       resp.AdminKeyID,
		AdminKeySecret:   resp.AdminKeySecret,
		MailboxID:        resp.MailboxID,
		WebAuthnEnrolURL: resp.WebAuthnEnrolURL,
	}

	// Headless path: a pre-signed WebAuthn token short-circuits the
	// browser ceremony entirely.
	if opts.WebAuthnToken != "" {
		if err := completeWithToken(ctx, httpc, opts, resp.SetupCode, resp.AdminKeyID, resp.AdminKeySecret); err != nil {
			return result, fmt.Errorf("genesis: complete with token: %w", err)
		}
		result.WebAuthnEnrolled = true
		return result, nil
	}

	// 5) Open browser (or print URL).
	fmt.Fprintf(out, "genesis: WebAuthn enrolment URL: %s\n", resp.WebAuthnEnrolURL)
	if !opts.NoBrowser {
		if err := opts.openBrowser(resp.WebAuthnEnrolURL); err != nil {
			fmt.Fprintf(out, "genesis: could not open browser (%v) — please open the URL above manually\n", err)
		}
	}

	// 6) Poll.
	completed, err := pollUntilComplete(ctx, httpc, opts, resp.SetupCode)
	if err != nil {
		return result, err
	}
	result.WebAuthnEnrolled = completed
	if completed {
		fmt.Fprintln(out, "genesis: WebAuthn enrolment complete")
	} else {
		fmt.Fprintln(out, "genesis: WebAuthn enrolment did not complete before timeout — admin key is usable; re-run `setup infra genesis-seal --force` to retry")
	}
	return result, nil
}

// postBootstrap signs + sends the POST /v1/admin/bootstrap request.
func postBootstrap(ctx context.Context, httpc *http.Client, opts SealOptions) ([]byte, int, error) {
	bodyBytes := []byte("{}")
	path := "/v1/admin/bootstrap"
	ts := polarissdk.NowMillis()
	nonce, err := polarissdk.GenerateNonce()
	if err != nil {
		return nil, 0, fmt.Errorf("genesis: nonce: %w", err)
	}
	sig, err := polarissdk.Sign(polarissdk.CanonicalInput{
		Direction: polarissdk.DirectionAPI,
		Method:    "POST",
		Path:      path,
		Query:     "",
		TS:        ts,
		Nonce:     nonce,
		Body:      bodyBytes,
	}, []byte(opts.MasterSecret))
	if err != nil {
		return nil, 0, fmt.Errorf("genesis: sign: %w", err)
	}

	target := strings.TrimRight(opts.APIBaseURL, "/") + path
	req, err := http.NewRequestWithContext(ctx, "POST", target, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Polaris-Ts", ts)
	req.Header.Set("X-Polaris-Nonce", nonce)
	req.Header.Set("X-Polaris-Sig", sig)
	if opts.IdempotencyKey != "" {
		req.Header.Set("Idempotency-Key", opts.IdempotencyKey)
	}
	req.Header.Set("User-Agent", "polaris-email-cli/genesis-seal")
	resp, err := httpc.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("genesis: bootstrap POST: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, 0, fmt.Errorf("genesis: read bootstrap response: %w", err)
	}
	return body, resp.StatusCode, nil
}

// completeWithToken POSTs the WebAuthn token to .../complete signed
// with the freshly minted admin key. Used on the headless path.
func completeWithToken(
	ctx context.Context,
	httpc *http.Client,
	opts SealOptions,
	setupCode, keyID, keySecret string,
) error {
	if setupCode == "" {
		return errors.New("genesis: setup code is empty")
	}
	body := map[string]string{"webauthn_token": opts.WebAuthnToken}
	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return err
	}
	path := "/v1/admin/setup/webauthn/" + url.PathEscape(setupCode) + "/complete"
	ts := polarissdk.NowMillis()
	nonce, err := polarissdk.GenerateNonce()
	if err != nil {
		return err
	}
	sig, err := polarissdk.Sign(polarissdk.CanonicalInput{
		Direction: polarissdk.DirectionAPI,
		Method:    "POST",
		Path:      path,
		Query:     "",
		TS:        ts,
		Nonce:     nonce,
		Body:      bodyBytes,
	}, []byte(keySecret))
	if err != nil {
		return err
	}
	target := strings.TrimRight(opts.APIBaseURL, "/") + path
	req, err := http.NewRequestWithContext(ctx, "POST", target, bytes.NewReader(bodyBytes))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Polaris-Ts", ts)
	req.Header.Set("X-Polaris-Nonce", nonce)
	req.Header.Set("X-Polaris-Sig", sig)
	req.Header.Set("X-Polaris-Key-Id", keyID)
	req.Header.Set("User-Agent", "polaris-email-cli/genesis-seal")
	resp, err := httpc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("complete returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

// writeBootstrapOutput writes the admin key blob to disk mode 0600.
// Format matches what bin/bootstrap.sh emitted: a flat JSON object
// with admin_key_id + admin_key_secret + created_at.
func writeBootstrapOutput(path string, resp bootstrapResponse) error {
	doc := struct {
		AdminKeyID     string `json:"admin_key_id"`
		AdminKeySecret string `json:"admin_key_secret"`
		MailboxID      string `json:"mailbox_id,omitempty"`
		CreatedAt      string `json:"created_at"`
	}{
		AdminKeyID:     resp.AdminKeyID,
		AdminKeySecret: resp.AdminKeySecret,
		MailboxID:      resp.MailboxID,
		CreatedAt:      time.Now().UTC().Format(time.RFC3339),
	}
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	// Atomic write via sibling tempfile + rename. Mode 0600 is applied
	// to the tempfile before rename so the final path is never readable
	// world-side.
	tmp, err := os.CreateTemp(dir, ".bootstrap-output-*.tmp")
	if err != nil {
		return err
	}
	cleanup := func() { _ = os.Remove(tmp.Name()) }
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		cleanup()
		return err
	}
	return nil
}

// validate fills in required fields + checks for missing-required.
func (o *SealOptions) validate() error {
	if o.APIBaseURL == "" {
		return errors.New("genesis: APIBaseURL is required")
	}
	if o.MasterSecret == "" {
		return errors.New("genesis: MasterSecret (POLARIS_SECRET_A) is required")
	}
	return nil
}

func (o *SealOptions) outOrStderr() io.Writer {
	if o.Out == nil {
		return os.Stderr
	}
	return o.Out
}

func (o *SealOptions) outputPath() string {
	if o.OutputPath != "" {
		return o.OutputPath
	}
	return DefaultBootstrapOutputPath
}

func (o *SealOptions) httpClient() *http.Client {
	if o.HTTPClient != nil {
		return o.HTTPClient
	}
	return &http.Client{Timeout: 30 * time.Second}
}

func (o *SealOptions) openBrowser(u string) error {
	if o.BrowserOpener != nil {
		return o.BrowserOpener(u)
	}
	return openBrowserDefault(u)
}

func (o *SealOptions) pollInterval() time.Duration {
	if o.PollInterval > 0 {
		return o.PollInterval
	}
	return DefaultPollInterval
}

func (o *SealOptions) pollTimeout() time.Duration {
	if o.PollTimeout > 0 {
		return o.PollTimeout
	}
	return DefaultPollTimeout
}
