# polaris-mail CLI

Operator CLI for the [polaris-mail](https://github.com/vladzaharia/polaris-email)
control plane. The same binary is symlinked as `pml`.

## Install

### Homebrew (macOS / Linux)

```sh
brew install vladzaharia/tap/polaris-mail
```

### `go install`

```sh
go install github.com/vladzaharia/polaris-email/apps/polaris-cli/cmd/polaris-mail@latest
ln -sf $(go env GOPATH)/bin/polaris-mail $(go env GOPATH)/bin/pml
```

### GitHub Releases

Download a static binary for your platform from
[Releases](https://github.com/vladzaharia/polaris-email/releases). Each archive
includes the `polaris-mail` binary; create a `pml` symlink in your path:

```sh
ln -sf polaris-mail pml
```

## First run — cold start

The CLI is **dual-mode**: with no args (and a TTY on stdout) it opens the
fullscreen tabbed TUI; with subcommands it operates non-interactively for
scripting.

```sh
polaris-mail setup infra        # admin: cold-start (preflight → … → smoke)
polaris-mail                    # operator: no args + TTY ⇒ fullscreen tabbed TUI
polaris-mail tui --theme=mocha  # operator: explicit TUI launch
polaris-mail status             # operator: non-interactive subcommand
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
polaris-mail setup infra --resume                 # pick up after a partial run
polaris-mail setup infra --phase smoke            # jump straight to smoke
polaris-mail setup infra --webauthn-token "<jwt>" # headless (CI) genesis-seal
polaris-mail setup infra --no-browser             # print enrolment URL only
polaris-mail setup infra --skip-smoke             # skip the final probe
```

Individual phases can also be invoked directly:

```sh
polaris-mail setup infra preflight
polaris-mail setup infra configure
polaris-mail setup infra plan
polaris-mail setup infra apply
polaris-mail setup infra render
polaris-mail setup infra migrate
polaris-mail setup infra secrets seed
polaris-mail setup infra deploy all
polaris-mail setup infra genesis-seal
polaris-mail setup infra smoke
polaris-mail setup infra ssh-bootstrap            # mint admin:impersonate key + SSH host key for `serve --ssh`
```

`polaris-mail setup infra` is the only cold-start path; the legacy
`make bootstrap` shell flow was retired in PR 14.

### Login (operator-side, after cold-start)

`polaris-mail login` is the recommended way to provide credentials. It
takes the bundled bearer printed by `polaris-mail operator add`
(`polaris_<key_id>.<secret>`) and stores it encrypted in the OS keychain
(macOS Keychain, Linux Secret Service / KWallet, Windows Credential
Manager). Headless hosts fall back to a passphrase-encrypted file in
`~/.config/polaris-mail/keyring/`.

```sh
polaris-mail login              # interactive paste
polaris-mail login --method=stdin < /tmp/token   # for CI
polaris-mail whoami             # cached operator identity
polaris-mail logout
polaris-mail profile list       # all stored profiles
```

### Credential resolution order

`MakeClient()` checks these in order; the first that yields a complete
triple (api-url + key-id + secret) wins:

1. CLI flag (`--api-url`, `--token`, `--key-id`)
2. Environment variable (`POLARIS_API_URL`, `POLARIS_TOKEN`, `POLARIS_KEY_ID`)
3. OS keychain credstore entry for the active `--profile` (or "default")
4. Legacy `~/.config/polaris-mail/config.toml` profile

`--token` and `$POLARIS_TOKEN` accept either the bundled bearer
(`polaris_<key_id>.<secret>`) or the raw secret with `--key-id` supplied
separately. The bundled form is preferred: it carries both halves in one
string.

### Operator enrollment

Any operator with `admin:rotate` scope can enroll new operators (it's not
gated to the bootstrap key):

```sh
polaris-mail operator add                       # interactive huh wizard
polaris-mail operator add --from-file ops.yaml  # CI / batch onboarding
polaris-mail operator list
polaris-mail operator rotate-key <id>           # returns a new login_token ONCE
polaris-mail operator disable <id> --confirm-id <id>
```

The wizard returns a one-shot `polaris_<id>.<secret>` token. Hand it to
the new operator; they paste it into their own `polaris-mail login`.

## Workflows

### A. Onboard a new domain

```sh
polaris-mail domain onboard acme.com --inbound --outbound
# or fully interactive (huh wizard):
polaris-mail domain onboard
# or non-interactive from a file:
polaris-mail domain onboard --from-file domain.yaml
```

The wizard discovers the Cloudflare zone, publishes DKIM/SPF/DMARC + MX,
enables Email Routing, and registers the domain in the control plane. By
default a single domain row implicitly covers all subdomains. Pass `--override`
to register `mail.acme.com` explicitly when its parent `acme.com` is already
managed.

Bulk subdomain provisioning (PaaS workflow):

```sh
polaris-mail domain bulk-onboard \
  --pattern 'tenant-{1..100}.app.example.com' \
  --zone example.com --outbound
```

### B. Issue credentials

The schema is mailbox-centric. Mailbox CRUD lives in the admin REST surface
(`POST /v1/admin/mailboxes`) or the panel UI. Once a mailbox exists, issue
credentials via:

```sh
polaris-mail cred issue \
  --mailbox <mailbox-id> --type smtp \
  --senders 'noreply@acme.com,alerts@mail.acme.com'
```

The `--tenant` flag is accepted as a deprecated alias for `--mailbox` and
prints a warning. Update CI scripts at your earliest convenience; the alias
will be removed in a future release.

The plaintext secret is printed exactly once. Pipe to your secret store:

```sh
polaris-mail cred issue ... -o json | jq -r .secret | op item create ...
```

### C. Manage routes

```sh
polaris-mail route list --domain acme.com
polaris-mail route add --domain acme.com --pattern 'support@*' \
  --action webhook --url https://example.com/email-hook
polaris-mail route apply -f routes.yaml   # declarative reconciliation
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
wrangler tail polaris-mail-out --status error --search "acme.com"
wrangler tail polaris-mail-api --status error --since 1h
wrangler tail polaris-mail-out --status ok   # full Workers log stream
polaris-mail status
polaris-mail webhook dlq list
polaris-mail webhook dlq drop <id> --confirm <id>
```

### E. Register a mail bridge

```sh
polaris-mail bridge register bridge-iad-1 --form compose \
  --write ./registration.json
```

This mints the bridge's HMAC key + Cloudflare Access service token (returned
once) and prints a docker-compose snippet ready to drop into the bridge host.

Deregistering a bridge requires `--confirm-name <name>` so a fat-finger
delete doesn't tear down a live host:

```sh
polaris-mail bridge deregister bridge-iad-1 --confirm-name bridge-iad-1
```

### F. Discover + configure Cloudflare zones

`cf-zone` operates against the live Cloudflare account (via the
`POST /v1/admin/cf-zones[...]` admin endpoints) and reconciles each zone
against polaris-mail's six readiness checks: Email Routing on, MX/SPF
records locked by Cloudflare, sender domain onboarded, catch-all rule
points at the `polaris-mail-in` Worker, no conflicting named rules, and
a matching `mail_domains` row in D1.

```sh
# Inventory every zone with rolled-up readiness pills.
polaris-mail domain cf-zone list
polaris-mail domain cf-zone list --refresh   # bypass the 60s server-side cache

# Drill into one zone — prints each check + DNS errors / missing records /
# named-rule routing targets.
polaris-mail domain cf-zone status plrs.im

# Plan a configure run (dry-run by default — nothing is applied).
polaris-mail domain cf-zone configure plrs.im

# Apply the planned ops (exits non-zero if any fail).
polaris-mail domain cf-zone configure plrs.im --apply

# Restrict to a subset of ops (useful for partial recovery after a failure).
polaris-mail domain cf-zone configure plrs.im --apply \
  --ops enable_routing,set_catch_all_worker
```

Output of a typical dry-run:

```
Zone: plrs.im
Diff:
  - enable_routing: Enable Cloudflare Email Routing on plrs.im
  - set_catch_all_worker: Point catch-all rule at the polaris-mail-in Worker
  - create_d1_mail_domain: Create polaris-mail mail_domains row for plrs.im

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
polaris-mail auth verify \
  --method POST --path /v1/messages --body req.json \
  --ts 1700000000000 --nonce <nonce> --sig <hex> \
  --secret "$(op read op://Vault/Polaris/secret)"
```

Returns `OK` on stdout (exit 0) for a valid signature; on failure prints
`INVALID code=<code> err=<reason>` on stderr (exit 1).

## Multi-profile usage

```sh
polaris-mail --profile staging domain list
polaris-mail --profile prod   tenant list
POLARIS_TOKEN="$(op read op://Vault/Polaris/token)" polaris-mail status
```

## Wizard JSON-schema files

Schemas for `--from-file` payloads live under
[`testdata/wizard-schemas/`](testdata/wizard-schemas):

- `domain.json` — `polaris-mail domain onboard --from-file ...`
- `cred.json` — `polaris-mail cred issue --from-file ...`
- `bridge.json` — `polaris-mail bridge register --from-file ...`

YAML and JSON inputs are both accepted. Validate with any draft-2020-12 JSON
Schema validator before piping into the CLI in CI.

## `--dry-run`

Every command honours `--dry-run`. The CLI signs the request, prints the
canonical `METHOD URL` plus headers (signature redacted) and JSON body, and
returns immediately without sending the request. Use this for agent / CI
preview mode:

```sh
polaris-mail domain onboard acme.com --inbound --outbound --dry-run
polaris-mail cred issue --mailbox <mailbox-id> --type smtp --senders 'a@b.com' --dry-run
```

## Build from source

```sh
make build           # bin/polaris-mail + bin/pml symlink
make test            # go test ./...
make vet             # go vet ./...
make release-dryrun  # goreleaser release --snapshot --clean --skip=publish
```
