package cmds

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	polarissdk "github.com/polaris-email/polaris-sdk-go"
)

// newAuthCmd returns the `polaris-email auth` subcommand group. Today it
// exposes `auth sign` (the canonical shell-callable signer that replaces the
// old `bin/_lib.sh:polaris_sign()` helper) and `auth verify` (D2: a
// shell-callable verifier so operators can debug bad-signature reports
// without writing Go).
func newAuthCmd() *cobra.Command {
	c := &cobra.Command{Use: "auth", Short: "Authentication helpers"}
	c.AddCommand(authSignCmd(), authVerifyCmd())
	return c
}

func authSignCmd() *cobra.Command {
	var (
		method    string
		path      string
		query     string
		bodyFile  string
		direction string
		secret    string
		nonceArg  string
		tsArg     string
	)
	c := &cobra.Command{
		Use:   "sign",
		Short: "Sign a request for the polaris-email API and print the headers",
		Long: `Compute the canonical-string HMAC for a polaris-email API request and
print the three required header values on stdout, one per line:

  X-Polaris-Ts: <unix-ms>
  X-Polaris-Nonce: <nonce>
  X-Polaris-Sig: <bare-lowercase-hex>

The secret is read from --secret or, by default, the POLARIS_SECRET
environment variable. The body is read from --body=<file> (use "-" for
stdin), defaulting to an empty body when omitted.

Direction defaults to "polaris-api". Use "polaris-webhook" for outbound
webhook deliveries.`,
		RunE: func(_ *cobra.Command, _ []string) error {
			if secret == "" {
				secret = os.Getenv("POLARIS_SECRET")
			}
			if secret == "" {
				return fmt.Errorf("auth sign: --secret or POLARIS_SECRET required")
			}
			if method == "" {
				return fmt.Errorf("auth sign: --method required")
			}
			if path == "" {
				return fmt.Errorf("auth sign: --path required")
			}
			if !strings.HasPrefix(path, "/") {
				return fmt.Errorf("auth sign: --path must start with /")
			}
			body, err := loadBody(bodyFile)
			if err != nil {
				return err
			}
			ts := tsArg
			if ts == "" {
				ts = polarissdk.NowMillis()
			}
			nonce := nonceArg
			if nonce == "" {
				n, err := polarissdk.GenerateNonce()
				if err != nil {
					return err
				}
				nonce = n
			}
			sig, err := polarissdk.Sign(polarissdk.CanonicalInput{
				Direction: polarissdk.Direction(direction),
				Method:    method,
				Path:      path,
				Query:     strings.TrimPrefix(query, "?"),
				TS:        ts,
				Nonce:     nonce,
				Body:      body,
			}, []byte(secret))
			if err != nil {
				return err
			}
			fmt.Fprintf(Out, "X-Polaris-Ts: %s\n", ts)
			fmt.Fprintf(Out, "X-Polaris-Nonce: %s\n", nonce)
			fmt.Fprintf(Out, "X-Polaris-Sig: %s\n", sig)
			return nil
		},
	}
	c.Flags().StringVar(&method, "method", "", "HTTP method (POST, GET, ...) [required]")
	c.Flags().StringVar(&path, "path", "", "request path with leading slash [required]")
	c.Flags().StringVar(&query, "query", "", "raw query string (no leading ?)")
	c.Flags().StringVar(&bodyFile, "body", "", "request body file ('-' = stdin; default: empty)")
	c.Flags().StringVar(&direction, "direction", "polaris-api", "HMAC direction tag")
	c.Flags().StringVar(&secret, "secret", "", "HMAC secret (default: $POLARIS_SECRET)")
	c.Flags().StringVar(&nonceArg, "nonce", "", "nonce override (default: random)")
	c.Flags().StringVar(&tsArg, "ts", "", "timestamp override (default: now in ms)")
	return c
}

// authVerifyCmd implements `polaris-email auth verify` — a shell-callable
// wrapper around polarissdk.VerifyWebhook for debugging bad-signature reports
// in production. Returns exit 0 on a valid signature, exit 1 with a one-line
// reason on stderr otherwise.
func authVerifyCmd() *cobra.Command {
	var (
		method    string
		path      string
		query     string
		bodyFile  string
		direction string
		secret    string
		sig       string
		ts        string
		nonce     string
	)
	c := &cobra.Command{
		Use:   "verify",
		Short: "Verify a polaris-email signature against the canonical scheme",
		Long: `Re-compute the canonical-string HMAC for the supplied request and
compare it against --sig. Returns 0 on a valid signature, 1 with a single-line
reason on stderr otherwise.

Use this to debug bad-signature reports from production: capture the
X-Polaris-* headers + the body bytes, then run:

  polaris-email auth verify \
    --method POST --path /v1/messages --body req.json \
    --ts 1700000000000 --nonce <nonce> --sig <hex> \
    --secret "$(op read op://Vault/Polaris/secret)"

The default direction is "polaris-api"; pass --direction polaris-webhook for
outbound webhook deliveries.`,
		RunE: func(_ *cobra.Command, _ []string) error {
			if secret == "" {
				secret = os.Getenv("POLARIS_SECRET")
			}
			if secret == "" {
				return fmt.Errorf("auth verify: --secret or POLARIS_SECRET required")
			}
			for _, p := range []struct{ name, value string }{
				{"--method", method},
				{"--path", path},
				{"--ts", ts},
				{"--nonce", nonce},
				{"--sig", sig},
			} {
				if p.value == "" {
					return fmt.Errorf("auth verify: %s required", p.name)
				}
			}
			if !strings.HasPrefix(path, "/") {
				return fmt.Errorf("auth verify: --path must start with /")
			}
			body, err := loadBody(bodyFile)
			if err != nil {
				return err
			}
			tsMs, err := parseTS(ts)
			if err != nil {
				return fmt.Errorf("auth verify: --ts not an int64: %w", err)
			}
			res := polarissdk.VerifyWebhook(polarissdk.VerifyInput{
				Direction: polarissdk.Direction(direction),
				Method:    method,
				Path:      path,
				Query:     strings.TrimPrefix(query, "?"),
				Headers: map[string]string{
					"x-polaris-ts":    ts,
					"x-polaris-nonce": nonce,
					"x-polaris-sig":   sig,
				},
				Body:        body,
				Secret:      []byte(secret),
				SkewSeconds: 0,
				Now:         time.UnixMilli(tsMs),
			})
			if !res.OK {
				fmt.Fprintf(Errw, "INVALID code=%s err=%v\n", res.Code, res.Err)
				return errSignatureInvalid
			}
			fmt.Fprintln(Out, "OK")
			return nil
		},
	}
	c.Flags().StringVar(&method, "method", "", "HTTP method [required]")
	c.Flags().StringVar(&path, "path", "", "request path with leading slash [required]")
	c.Flags().StringVar(&query, "query", "", "raw query string (no leading ?)")
	c.Flags().StringVar(&bodyFile, "body", "", "request body file ('-' = stdin; default: empty)")
	c.Flags().StringVar(&direction, "direction", "polaris-api", "HMAC direction tag")
	c.Flags().StringVar(&secret, "secret", "", "HMAC secret (default: $POLARIS_SECRET)")
	c.Flags().StringVar(&sig, "sig", "", "X-Polaris-Sig value (bare lowercase hex) [required]")
	c.Flags().StringVar(&ts, "ts", "", "X-Polaris-Ts value (unix-ms) [required]")
	c.Flags().StringVar(&nonce, "nonce", "", "X-Polaris-Nonce value [required]")
	return c
}

// errSignatureInvalid is returned by `auth verify` so the cobra exit code is
// non-zero. The verbose reason is already printed to stderr.
var errSignatureInvalid = errors.New("signature invalid")

// parseTS parses a unix-ms decimal string. Kept as a tiny helper so tests
// don't have to import strconv just for this.
func parseTS(s string) (int64, error) {
	var n int64
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < '0' || c > '9' {
			return 0, fmt.Errorf("non-digit %q at %d", c, i)
		}
		n = n*10 + int64(c-'0')
	}
	return n, nil
}

func loadBody(spec string) ([]byte, error) {
	if spec == "" {
		return nil, nil
	}
	if spec == "-" {
		return readAll(os.Stdin)
	}
	return os.ReadFile(spec)
}

// readAll is a thin helper so tests can swap stdin without depending on io.
func readAll(r interface {
	Read(p []byte) (n int, err error)
}) ([]byte, error) {
	var out []byte
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			out = append(out, buf[:n]...)
		}
		if err != nil {
			// Use errors.Is(err, io.EOF) — string comparison was fragile and
			// would have missed wrapped EOFs (e.g. an *os.PathError wrapping
			// the underlying EOF). io.EOF is the canonical sentinel.
			if errors.Is(err, io.EOF) {
				return out, nil
			}
			return out, err
		}
	}
}
