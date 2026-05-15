# polaris-email CLI

Operator CLI for the [polaris-email](https://github.com/vladzaharia/polaris-email)
control plane. The same binary is symlinked as `pml`.

## Install

### Homebrew (macOS / Linux)

```sh
brew install vladzaharia/tap/polaris-email
```

### `go install`

```sh
go install github.com/vladzaharia/polaris-email/apps/polaris-cli/cmd/polaris-email@latest
ln -sf $(go env GOPATH)/bin/polaris-email $(go env GOPATH)/bin/pml
```

### GitHub Releases

Download a static binary for your platform from
[Releases](https://github.com/vladzaharia/polaris-email/releases). Each archive
includes the `polaris-email` binary; create a `pml` symlink in your path:

```sh
ln -sf polaris-email pml
```

## First run

```sh
polaris-email bootstrap --webauthn-token "<token>"
```

This runs the one-time control-plane initialization: anchors the genesis audit
entry, enrols WebAuthn for the operator account, and seeds the
`bootstrap_completed` row. Subsequent invocations refuse unless the prior
bootstrap is provably destroyed.

After bootstrap, write your config file at
`~/.config/polaris-email/config.toml`:

```toml
default = "prod"

[profiles.prod]
api_url    = "https://api.polaris-email.example.com"
token      = "<HMAC secret>"
key_id     = "<API key id>"
account_id = "<CF account id>"

[profiles.staging]
api_url    = "https://staging-api.polaris-email.example.com"
token      = "<staging secret>"
key_id     = "<staging key id>"
```

Select a profile with `--profile staging` (default is `prod`). `--api-url`,
`--token`, and `--key-id` always override config-file values.

## Workflows

### A. Onboard a new domain

```sh
polaris-email domain onboard acme.com --inbound --outbound
# or fully interactive (huh wizard):
polaris-email domain onboard
# or non-interactive from a file:
polaris-email domain onboard --from-file domain.yaml
```

The wizard discovers the Cloudflare zone, publishes DKIM/SPF/DMARC + MX,
enables Email Routing, and registers the domain in the control plane. By
default a single domain row implicitly covers all subdomains. Pass `--override`
to register `mail.acme.com` explicitly when its parent `acme.com` is already
managed.

Bulk subdomain provisioning (PaaS workflow):

```sh
polaris-email domain bulk-onboard \
  --pattern 'tenant-{1..100}.app.example.com' \
  --zone example.com --outbound
```

### B. Issue credentials

The schema is mailbox-centric. Mailbox CRUD lives in the admin REST surface
(`POST /v1/admin/mailboxes`) or the panel UI. Once a mailbox exists, issue
credentials via:

```sh
polaris-email cred issue \
  --mailbox <mailbox-id> --type smtp \
  --senders 'noreply@acme.com,alerts@mail.acme.com'
```

The plaintext secret is printed exactly once. Pipe to your secret store:

```sh
polaris-email cred issue ... -o json | jq -r .secret | op item create ...
```

### C. Manage routes

```sh
polaris-email route list --domain acme.com
polaris-email route add --domain acme.com --pattern 'support@*' \
  --action webhook --url https://example.com/email-hook
polaris-email route apply -f routes.yaml   # declarative reconciliation
```

`routes.yaml` example:

```yaml
routes:
  - domain_name: acme.com
    pattern: support@*
    action: webhook
    url: https://example.com/email-hook
  - domain_name: acme.com
    pattern: bounce@*
    action: drop
```

### D. Inspect activity

```sh
wrangler tail polaris-email-out --status error --search "acme.com"
wrangler tail polaris-email-api --status error --since 1h
wrangler tail polaris-email-out --status ok   # full Workers log stream
polaris-email status
polaris-email webhook dlq list
polaris-email webhook dlq drop <id> \
  --confirm <id> --operator-token-a <op1-token> --operator-token-b <op2-token>
```

### E. Register a mail bridge

```sh
polaris-email bridge register bridge-iad-1 --form compose \
  --write ./registration.json
```

This mints the bridge's HMAC key + Cloudflare Access service token (returned
once) and prints a docker-compose snippet ready to drop into the bridge host.

## Multi-profile usage

```sh
polaris-email --profile staging domain list
polaris-email --profile prod   tenant list
POLARIS_TOKEN="$(op read op://Vault/Polaris/token)" polaris-email status
```

## Wizard JSON-schema files

Schemas for `--from-file` payloads live under
[`testdata/wizard-schemas/`](testdata/wizard-schemas):

- `domain.json` — `polaris-email domain onboard --from-file ...`
- `cred.json` — `polaris-email cred issue --from-file ...`
- `bridge.json` — `polaris-email bridge register --from-file ...`

YAML and JSON inputs are both accepted. Validate with any draft-2020-12 JSON
Schema validator before piping into the CLI in CI.

## `--dry-run`

Every command honours `--dry-run`. The CLI signs the request, prints the
canonical `METHOD URL` plus headers (signature redacted) and JSON body, and
returns immediately without sending the request. Use this for agent / CI
preview mode:

```sh
polaris-email domain onboard acme.com --inbound --outbound --dry-run
polaris-email cred issue --mailbox <mailbox-id> --type smtp --senders 'a@b.com' --dry-run
```

## Build from source

```sh
make build           # bin/polaris-email + bin/pml symlink
make test            # go test ./...
make vet             # go vet ./...
make release-dryrun  # goreleaser release --snapshot --clean --skip=publish
```
