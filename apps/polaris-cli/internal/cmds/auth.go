package cmds

import (
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	polarissdk "github.com/polaris-email/polaris-sdk-go"
)

// newAuthCmd returns the `polaris-email auth` subcommand group. Today it
// exposes a single member, `auth sign`, which replaces the old
// `bin/_lib.sh:polaris_sign()` shell helper. Shell scripts shell out to
// `polaris-email auth sign` so the canonical signing logic lives in one
// place — the Go SDK.
func newAuthCmd() *cobra.Command {
	c := &cobra.Command{Use: "auth", Short: "Authentication helpers"}
	c.AddCommand(authSignCmd())
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
			if err.Error() == "EOF" {
				return out, nil
			}
			return out, err
		}
	}
}
