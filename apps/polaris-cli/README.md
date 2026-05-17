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

## First run — cold start

```sh
polaris-email setup infra
```

`setup infra` (no leaf) drives the full happy path end-to-end:

1. **preflight** — verify tooling + `.env.deploy`
2. **configure** — validate (or interactively rebuild) `.env.deploy`
3. **plan + apply** — provision Cloudflare resources (D1, R2, KV, Queues)
4. **render** — generate `wrangler.local.jsonc` for every Worker
5. **migrate** — apply D1 migrations
6. **secrets seed** — generate + push `POLARIS_SECRET_A`, `ARGON2_PEPPER`, etc. (values stay in-memory)
7. **deploy** — `wrangler deploy` every Worker
8. **genesis-seal** — sign `POST /v1/admin/bootstrap` with the freshly seeded
   `POLARIS_SECRET_A`, capture the minted admin key into
   `.bootstrap-output.json` (mode 0600), open the operator's browser for
   WebAuthn enrolment, poll for completion
9. **smoke** — healthz + signed status + synthetic outbound

Each phase records its completion to `.deploy-state.json` so
`--resume` short-circuits past completed phases on retry:

```sh
polaris-email setup infra --resume                 # pick up after a partial run
polaris-email setup infra --phase smoke            # jump straight to smoke
polaris-email setup infra --webauthn-token "<jwt>" # headless (CI) genesis-seal
polaris-email setup infra --no-browser             # print enrolment URL only
polaris-email setup infra --skip-smoke             # skip the final probe
```

Individual phases can also be invoked directly:

```sh
polaris-email setup infra preflight
polaris-email setup infra configure
polaris-email setup infra plan
polaris-email setup infra apply
polaris-email setup infra render
polaris-email setup infra migrate
polaris-email setup infra secrets seed
polaris-email setup infra deploy all
polaris-email setup infra genesis-seal
polaris-email setup infra smoke
```

The legacy `make bootstrap` shell path remains authoritative during the
soak window; once PR 14 retires `bin/*.sh`, `setup infra` is the only
cold-start path.

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

Select a profile with `--profile staging` (default is `prod`). The
resolution order for `--api-url`, `--token`, and `--key-id` is:

1. CLI flag (`--api-url`, `--token`, `--key-id`)
2. Environment variable (`POLARIS_API_URL`, `POLARIS_TOKEN`, `POLARIS_KEY_ID`)
3. Profile in the config file

This means `POLARIS_TOKEN=$(op read …) polaris-email status` works even when
no config file is present — the env vars carry the credentials.

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

The `--tenant` flag is accepted as a deprecated alias for `--mailbox` and
prints a warning. Update CI scripts at your earliest convenience; the alias
will be removed in a future release.

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
polaris-email webhook dlq drop <id> --confirm <id>
```

### E. Register a mail bridge

```sh
polaris-email bridge register bridge-iad-1 --form compose \
  --write ./registration.json
```

This mints the bridge's HMAC key + Cloudflare Access service token (returned
once) and prints a docker-compose snippet ready to drop into the bridge host.

Deregistering a bridge requires `--confirm-name <name>` so a fat-finger
delete doesn't tear down a live host:

```sh
polaris-email bridge deregister bridge-iad-1 --confirm-name bridge-iad-1
```

### F. Discover + configure Cloudflare zones

`cf-zone` operates against the live Cloudflare account (via the
`POST /v1/admin/cf-zones[...]` admin endpoints) and reconciles each zone
against polaris-email's six readiness checks: Email Routing on, MX/SPF
records locked by Cloudflare, sender domain onboarded, catch-all rule
points at the `polaris-email-in` Worker, no conflicting named rules, and
a matching `mail_domains` row in D1.

```sh
# Inventory every zone with rolled-up readiness pills.
polaris-email cf-zone list
polaris-email cf-zone list --refresh   # bypass the 60s server-side cache

# Drill into one zone — prints each check + DNS errors / missing records /
# named-rule routing targets.
polaris-email cf-zone status plrs.im

# Plan a configure run (dry-run by default — nothing is applied).
polaris-email cf-zone configure plrs.im

# Apply the planned ops (exits non-zero if any fail).
polaris-email cf-zone configure plrs.im --apply

# Restrict to a subset of ops (useful for partial recovery after a failure).
polaris-email cf-zone configure plrs.im --apply \
  --ops enable_routing,set_catch_all_worker
```

Output of a typical dry-run:

```
Zone: plrs.im
Diff:
  - enable_routing: Enable Cloudflare Email Routing on plrs.im
  - set_catch_all_worker: Point catch-all rule at the polaris-email-in Worker
  - create_d1_mail_domain: Create polaris-email mail_domains row for plrs.im

Warnings:
  ⚠ 2 named-address rule(s) on plrs.im route mail elsewhere

(dry run — pass --apply to actually configure)
```

`-o json` returns the raw envelope (`ZoneConfigureResult` for `configure`,
`CFZonesListResponse` for `list`, `ZoneDomainStatus` for `status`) so the
output can be piped into jq or stored as an audit artefact.

### G. Verify a bad-signature report

When a webhook subscriber reports a verification failure, capture the
`X-Polaris-*` headers + raw body and replay them locally:

```sh
polaris-email auth verify \
  --method POST --path /v1/messages --body req.json \
  --ts 1700000000000 --nonce <nonce> --sig <hex> \
  --secret "$(op read op://Vault/Polaris/secret)"
```

Returns `OK` on stdout (exit 0) for a valid signature; on failure prints
`INVALID code=<code> err=<reason>` on stderr (exit 1).

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
