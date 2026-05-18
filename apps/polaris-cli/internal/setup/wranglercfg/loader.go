package wranglercfg

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

// LoadInputs bridges PR 1's state.Doc and the (still-shell) .env.deploy
// file into a RenderInputs ready to feed Render. PR 2 will land a typed
// config package; once it's on main, this function will gain a
// *config.Config parameter and fall back to direct env-file parsing only
// when called from contexts that haven't loaded one yet.
//
// envPath may be empty, in which case LoadInputs only consults the
// process environment (useful for tests that t.Setenv their values).
// Missing optional fields are left zero — Validate() decides what counts
// as required.
func LoadInputs(doc *state.Doc, envPath string) (*RenderInputs, error) {
	env, err := loadEnvFile(envPath)
	if err != nil {
		return nil, err
	}
	get := func(key string) string {
		if v, ok := env[key]; ok && v != "" {
			return v
		}
		return os.Getenv(key)
	}

	in := &RenderInputs{
		Account: AccountInputs{
			ID: pick(get("CF_ACCOUNT_ID"), doc.AccountID),
		},
		Hostnames: HostnameInputs{
			PolarisAPI: get("POLARIS_API_HOSTNAME"),
			R2Public:   get("R2_PUBLIC_HOST"),
			Bridge:     get("BRIDGE_HOST"),
		},
		Synthetic: SyntheticInputs{
			From:          get("SYNTHETIC_FROM"),
			To:            get("SYNTHETIC_TO"),
			MonitorDomain: get("SYNTHETIC_MONITOR_DOMAIN"),
		},
		OIDC: OIDCInputs{
			Issuer:   get("OIDC_ISSUER"),
			ClientID: get("OIDC_CLIENT_ID"),
		},
		SecretsStore: SecretsStoreInputs{
			StoreID: get("POLARIS_SECRETS_STORE_ID"),
		},
		AlertWebhook: get("ALERT_WEBHOOK"),
		LogpushURL:   get("LOGPUSH_DESTINATION_URL"),
	}

	if doc != nil {
		populateD1(&in.D1, doc)
		populateR2(&in.R2, doc)
		populateKV(&in.KV, doc)
		populateQueues(&in.Queues, doc)
	}

	return in, nil
}

func populateD1(out *D1Inputs, doc *state.Doc) {
	if r, ok := doc.D1["polaris-email"]; ok {
		out.PolarisEmail = D1Database{ID: r.ID, Name: nameOr(r.Name, "polaris-email")}
	}
}

func populateR2(out *R2Inputs, doc *state.Doc) {
	if b, ok := doc.R2["polaris-email"]; ok {
		out.PolarisEmail = R2Bucket{
			Name:         nameOr(b.Name, "polaris-email"),
			Jurisdiction: b.Jurisdiction,
		}
	}
}

// kvStateKeys maps the canonical state-file key (the human name used by
// bin/bootstrap.sh) onto the typed RenderInputs field. Keeping this in
// one place makes "where does .KV.Foo come from?" trivially greppable.
var kvStateKeys = map[string]func(*KVInputs, state.Resource){
	"polaris-email-nonce":       func(k *KVInputs, r state.Resource) { k.Nonce = toKV(r) },
	"polaris-email-idempotency": func(k *KVInputs, r state.Resource) { k.Idempotency = toKV(r) },
	"polaris-email-rate-limit":  func(k *KVInputs, r state.Resource) { k.RateLimit = toKV(r) },
	"polaris-email-key-cache":   func(k *KVInputs, r state.Resource) { k.KeyCache = toKV(r) },
	"polaris-email-revocations": func(k *KVInputs, r state.Resource) { k.Revocations = toKV(r) },
}

func populateKV(out *KVInputs, doc *state.Doc) {
	for key, setter := range kvStateKeys {
		if r, ok := doc.KV[key]; ok {
			setter(out, r)
		}
	}
}

func toKV(r state.Resource) KVNamespace {
	return KVNamespace{ID: r.ID, Name: r.Name}
}

// queueStateKeys lets future templates reference queue IDs by name. The
// current four templates don't, so this is reserved-but-empty in
// practice — the wiring is here so a follow-on PR doesn't have to
// re-discover the mapping.
var queueStateKeys = map[string]func(*QueueInputs, state.Resource){
	"polaris-email-outbound":     func(q *QueueInputs, r state.Resource) { q.Outbound = toQueue(r) },
	"polaris-email-inbound":      func(q *QueueInputs, r state.Resource) { q.Inbound = toQueue(r) },
	"polaris-email-fanout":       func(q *QueueInputs, r state.Resource) { q.Fanout = toQueue(r) },
	"polaris-email-outbound-dlq": func(q *QueueInputs, r state.Resource) { q.OutboundDLQ = toQueue(r) },
	"polaris-email-fanout-dlq":   func(q *QueueInputs, r state.Resource) { q.FanoutDLQ = toQueue(r) },
}

func populateQueues(out *QueueInputs, doc *state.Doc) {
	for key, setter := range queueStateKeys {
		if r, ok := doc.Queues[key]; ok {
			setter(out, r)
		}
	}
}

func toQueue(r state.Resource) Queue {
	return Queue{ID: r.ID, Name: r.Name}
}

func nameOr(name, fallback string) string {
	if name == "" {
		return fallback
	}
	return name
}

func pick(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// loadEnvFile is a deliberately small .env parser sufficient for the
// shape bin/configure.sh emits: lines like KEY="value", KEY=value, and
// `#` comments. We do NOT do shell expansion (no $VAR substitution),
// process substitution, or quoting tricks — anyone who wants those
// features should be using a real shell, not relying on this loader.
//
// Returning an empty map for "file does not exist" is intentional:
// LoadInputs falls back to the process environment so the CLI can
// render in CI without a checked-in .env.deploy.
func loadEnvFile(path string) (map[string]string, error) {
	out := map[string]string{}
	if path == "" {
		return out, nil
	}
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return out, nil
		}
		return nil, fmt.Errorf("wranglercfg: open env file %s: %w", path, err)
	}
	defer func() { _ = f.Close() }()

	sc := bufio.NewScanner(f)
	// .env.deploy lines are short but we bump the buffer in case
	// someone stuffs a long JSON value into it.
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	lineNo := 0
	for sc.Scan() {
		lineNo++
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			return nil, fmt.Errorf("wranglercfg: %s:%d: malformed env line (no `=`): %q", path, lineNo, line)
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		// Drop a single layer of surrounding "..." or '...' quotes if
		// present. Matches what `set -a; source .env.deploy` would do
		// for the shapes configure.sh writes.
		if len(val) >= 2 {
			first, last := val[0], val[len(val)-1]
			if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
				val = val[1 : len(val)-1]
			}
		}
		out[key] = val
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("wranglercfg: scan env file %s: %w", path, err)
	}
	return out, nil
}
