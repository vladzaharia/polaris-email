---
title: polaris-mail CLI tour
description: A one-page walkthrough of the major operator CLI verb domains — domain, cred, route, webhook, bridge, audit, suppression. Each section links into a dedicated day-2 workflow page.
sidebar_label: CLI tour
sidebar_position: 1
---

# polaris-mail CLI tour

The `polaris-mail` Go binary (alias `pml`) is the operator surface for
every day-2 workflow. Day-to-day mutations — issuing keys, onboarding
domains, rotating creds, replaying DLQ rows — run through this CLI, not
through `bin/*` scripts and not through the root `Makefile`. The
Makefile is reserved for cold-start orchestration; see
[Deployment](/operators) for that path.

This page is the entry point for the rest of the Day-2 section. Each
verb domain below links to a dedicated page with the full workflow.

## Install

```sh
# macOS / Linux via Homebrew
brew install vladzaharia/tap/polaris-mail

# or via go install
go install github.com/vladzaharia/polaris-email/apps/polaris-cli/cmd/polaris-mail@latest
ln -sf $(go env GOPATH)/bin/polaris-mail $(go env GOPATH)/bin/pml

# or download a static binary from GitHub Releases and symlink
ln -sf polaris-mail pml
```

## Configure a profile

Drop a profile file at `~/.config/polaris-mail/config.toml`:

```toml
default = "prod"

[profiles.prod]
api_url    = "https://api.polaris-mail.example.com"
token      = "<HMAC secret>"
key_id     = "<API key id>"
account_id = "<CF account id>"
```

Credentials resolve in order: CLI flag → environment variable
(`POLARIS_API_URL`, `POLARIS_TOKEN`, `POLARIS_KEY_ID`) → profile. That
means `POLARIS_TOKEN=$(op read …) polaris-mail status` works without
ever touching the config file.

Pick a non-default profile with `--profile staging`.

## Global flags

- `--profile <name>` — choose a non-default profile.
- `--dry-run` — sign and print the canonical request (signature
  redacted) without sending it. Honoured by every mutating command.
- `-o json` — return the raw envelope; pipe through `jq` for scripting.

## Verb domains

The CLI groups commands by resource. Each verb domain has a dedicated
day-2 page; this section is a one-line orientation per domain.

### `domain` — manage email domains

```sh
polaris-mail domain onboard acme.com --inbound --outbound
polaris-mail domain verify acme.com
polaris-mail domain rotate-dkim acme.com
polaris-mail domain delete acme.com
```

The mailbox-centric schema replaced the old tenant-centric one. CLI
output and DNS verification still talk about "domains" because those
are real DNS objects, but the row underneath each domain hangs off a
mailbox via `mail_domains`. See
[Domain management](/operators/day-2/domain-management).

### `cf-zone` — discover and configure Cloudflare zones

```sh
polaris-mail domain cf-zone list
polaris-mail domain cf-zone status plrs.im
polaris-mail domain cf-zone configure plrs.im              # dry-run by default
polaris-mail domain cf-zone configure plrs.im --apply
```

The CF-first path: instead of declaring "onboard this domain by name",
you pick from the live list of zones in the operator's CF account and
converge each one to the canonical state. Preferred over `domain
onboard` for any zone that lives in the same CF account. See
[Domain management](/operators/day-2/domain-management#cf-zone-discover-and-configure).

### `cred` — issue, list, rotate, revoke outbound credentials

```sh
polaris-mail cred issue --mailbox <mailbox-id> --type api \
    --senders "noreply@acme.com" --output secret-file
polaris-mail cred list --mailbox <mailbox-id>
polaris-mail cred rotate <id> --planned
polaris-mail cred revoke <id>
```

Plaintext is shown exactly once at issuance — the control plane stores
hashes only. See [Credential management](/operators/day-2/credential-management).

### `route` — manage inbound routing rules

```sh
polaris-mail route list --domain acme.com
polaris-mail route add --domain acme.com --pattern 'support@*' \
    --action webhook --url https://example.com/email-hook
polaris-mail route apply -f routes.yaml
```

Routes are stored in `routing_rules` (D1); the inbound Worker
dispatches by exact IDNA-normalised recipient match. The Cloudflare
Email Routing rule is a single per-zone catch-all — the named-pattern
logic is all in polaris-mail. See
[Routing and webhooks](/operators/day-2/routing-and-webhooks).

### `webhook` — webhook subscriptions and DLQ

```sh
polaris-mail webhook dlq list
polaris-mail webhook dlq inspect <id>
polaris-mail webhook dlq replay <id>
polaris-mail webhook dlq drop <id> --confirm <id>
```

Webhook signing happens in the queue consumer inside `services/api`
(domain tag `polaris-webhook`). The DLQ collects deliveries that
exhausted retries; replay and drop are operator-driven. See
[Routing and webhooks](/operators/day-2/routing-and-webhooks#webhook-dlq).

### `bridge` — register and rotate on-prem mail bridges

```sh
polaris-mail bridge list
polaris-mail bridge register edge-eu1 --form compose --write ./registration.json
polaris-mail bridge rotate edge-eu1
polaris-mail bridge deregister edge-eu1 --confirm-name edge-eu1
```

Each bridge has its own HMAC key and Cloudflare Access service token.
The global `BRIDGE_HMAC_KEY` was retired so that a single leaked key no
longer compromises every bridge. See
[Bridge management](/operators/day-2/bridge-management).

### `audit` — chain verification

```sh
polaris-mail audit verify
```

Walks `audit_log` and recomputes each row's hash
(`SHA-256(prev_hash || canonical(row))`). Any divergence between the
recomputed and stored values is a tamper signal. See
[Activity inspection](/operators/day-2/activity-inspection#audit-chain)
for the full procedure and the
[CF account compromise runbook](/operators/runbooks/cf-account-compromise)
for what to do when a break is reported.

### `suppression` — manage the bi-directional suppression list

```sh
polaris-mail suppress list
polaris-mail suppress check user@example.com
polaris-mail suppress add
polaris-mail suppress remove <id>
```

The suppression list is bi-directional: bounces and complaints from
outbound deliveries land here, and inbound mail from suppressed
addresses is also dropped. Surfaced in
[Activity inspection](/operators/day-2/activity-inspection#suppression-list).

### `status` — red/yellow/green snapshot

```sh
polaris-mail status                       # all rollups
polaris-mail status --domain acme.com     # one domain
polaris-mail status --queues              # queue + DLQ depths only
```

`--queues` is the fast path for DLQ-depth alerts — it skips per-domain
rollups and returns just the inbound / outbound / fanout queue and DLQ
depths. See [Activity inspection](/operators/day-2/activity-inspection).

### `auth` — sign and verify HMAC requests

```sh
polaris-mail auth sign --method POST --path /v1/messages --body req.json
polaris-mail auth verify \
    --method POST --path /v1/messages --body req.json \
    --ts 1700000000000 --nonce <nonce> --sig <hex> \
    --secret "$(op read op://Vault/Polaris/secret)"
```

`auth verify` reproduces the HMAC verification path used by the control
plane against a canonical-string + signature pair. Useful when a client
reports `bad_signature` and you need to confirm whether the bug is on
the signer or the verifier. See the
[HMAC reference](/security/hmac-reference) for the canonical-string spec.

## Next steps

- [Domain management](/operators/day-2/domain-management) — onboard,
  verify, decommission.
- [Mailbox management](/operators/day-2/mailbox-management) — the
  resource everything else hangs off of.
- [Credential management](/operators/day-2/credential-management) —
  issue, rotate, revoke.
- [Routing and webhooks](/operators/day-2/routing-and-webhooks) —
  inbound routes plus webhook DLQ ops.
- [Activity inspection](/operators/day-2/activity-inspection) — status,
  logs, audit chain.
- [Bridge management](/operators/day-2/bridge-management) — multi-host
  on-prem bridges.

<!-- Verified against: apps/polaris-cli/README.md @ c3c1b5048dd5bfe92facdce24982141a07446042 -->
