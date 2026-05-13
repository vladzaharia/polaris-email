# polaris-email operator guide

Operator-facing documentation for running and maintaining a polaris-email
deployment. Pairs with `docs/RUNBOOK.md` (incident response) and
`docs/cost-model.md` (financial planning).

## Prerequisites

- Cloudflare account on the **Workers Paid** plan with Email Routing and Email
  Service available. (Phase −1 spike must pass first; see `docs/spike/README.md`.)
- Three Cloudflare accounts provisioned (`polaris-prod`, `polaris-anchors`,
  `polaris-staging`) per the multi-account topology (I11). At minimum prod is
  required to start.
- `polaris-email` CLI installed: `brew install vladzaharia/tap/polaris-email`,
  or `go install github.com/vladzaharia/polaris-email/apps/polaris-cli/cmd/polaris-email@latest`,
  or download from GitHub Releases.
- `terraform` 1.6+ for IaC managing DNS, Email Routing rules, Email Service
  onboarding, and Cloudflare Access apps.
- `wrangler` CLI for Workers/D1/KV/R2/Queues deploys.

## Bootstrap

One-time per environment:

```bash
polaris-email bootstrap --env prod
```

The wizard:

1. Reads CF account IDs + scoped API tokens from prompt or `--from-file`.
2. Provisions D1 databases (`polaris-control`, `polaris-messages-2026-NN`,
   `polaris-audit`), KV namespaces, R2 buckets (including the anchors bucket
   in the `polaris-anchors` account with object lock in compliance mode), and
   Queues.
3. Runs schema migrations from `services/api/migrations/{control,messages,audit}/`.
4. Deploys the modular monolith Worker (`workers/control-plane`) and the
   inbound handler (`workers/in`).
5. Mints the first operator API key with `admin:read` + `admin:audit:rotate`
   scopes, anchored as the genesis audit entry (H9).
6. Saves a `terraform.tfvars` skeleton you can fill in for the IaC pieces.

## Five workflows

### A. Onboard a new domain

```bash
polaris-email domain onboard acme.com
```

Steps the wizard walks you through:

1. Capabilities: pick inbound, outbound, or both. `--wildcard-subdomains`
   defaults to true (covers `*.acme.com` automatically; explicit subdomain
   onboarding only when override is needed — see Resolved Q6).
2. CF zone discovery (walks up subdomain labels if needed; refuses if no
   parent zone is on the account).
3. Outbound onboarding via Email Service. **Cloudflare auto-publishes the
   DKIM CNAME (with wildcard if `wildcard_subdomains`), SPF, DMARC, and
   `cf-bounce` MX records on the zone**; we just confirm via DoH that they
   appeared. DKIM key is ed25519 by default, RSA-2048 fallback. (Operators
   running on non-CF DNS pass `--cf-managed-dns=false` and the wizard falls
   back to publishing the records itself via the DNS API.)
4. Inbound onboarding: Email Routing enable (CF auto-publishes the inbound
   MX records pointing at `route1/2/3.mx.cloudflare.net`) + single
   catch-all rule `*@<zone>` → `workers/in` (per I8 catch-all-only routing).
5. DNS verification state machine (A10): `published → seen_via_authoritative
   → seen_via_three_resolvers → confirmed`. The `published` step now means
   "CF reports the record exists in its zone" — a CF API check, not a
   write-and-poll. The remaining steps are DoH-only and confirm the
   public-internet view matches.
6. Registers the `domains` row + `dkim_keys(state='active')` row.

Non-interactive: `polaris-email domain onboard --from-file domain.toml`. The
TOML schema is documented in `docs/schemas/domain-onboard.toml.json`.

### B. Manage tenants

```bash
polaris-email tenant create newsletter --description "marketing newsletter sender"
polaris-email tenant list
polaris-email tenant show newsletter
polaris-email tenant rotate-pepper newsletter   # bumps pepper_version on messages
polaris-email tenant disable newsletter
```

A tenant is a consumer aggregate. It has zero or more **principals** (API keys
+ SMTP credentials). Senders are attached implicitly via `polaris-email cred
issue --tenant <name> --senders <list>`.

### C. Manage credentials

```bash
# API key for REST send
polaris-email cred issue --tenant newsletter --type api \
    --senders "noreply@acme.com,alerts@mail.acme.com" \
    --output secret-file --output-path ./newsletter-api.key

# SMTP credential for legacy clients
polaris-email cred issue --tenant newsletter --type smtp \
    --senders "noreply@acme.com" \
    --output json   # for piping to op/pass

# List, revoke, rotate
polaris-email cred list --tenant newsletter
polaris-email cred revoke <id>
polaris-email cred rotate <id> --planned       # demote to secondary
polaris-email cred rotate <id> --emergency     # immediate revoke + new key
```

Plaintext is shown **once** at issuance. The CLI never reads it back.

### D. Manage inbound routes

```bash
polaris-email route list --domain acme.com
polaris-email route add --domain acme.com \
    --pattern 'support@acme.com' --action webhook --url https://...
polaris-email route apply -f routes.yaml      # declarative reconciliation
```

Routes are stored in `routing_rules` D1; the inbound Worker dispatches by
exact IDNA-normalized recipient match (H2). The Cloudflare Email Routing rule
is a single per-zone catch-all; specific routing logic is in our code.

### E. Inspect activity

```bash
polaris-email status --domain acme.com         # red/yellow/green snapshot
polaris-email logs send --domain acme.com --follow
polaris-email logs in --domain acme.com --since 1h
polaris-email logs webhooks --domain acme.com --status failed
polaris-email webhook dlq list
polaris-email webhook dlq inspect <id>
polaris-email webhook dlq replay <id>
polaris-email webhook dlq drop <id> --confirm <id>   # two-person rule
polaris-email audit verify                     # walk hash chain
polaris-email audit anchors                    # list R2 anchors
polaris-email cost --month 2026-05             # current month bill
```

## Multi-host daemons

Submission daemons (Go binary `polaris-daemon`) accept legacy SMTP submission
and forward to the API. Each daemon has its own identity:

```bash
polaris-email daemon register edge-eu1
# Returns docker-compose snippet + registration.json to deposit on the host.

polaris-email daemon list
polaris-email daemon rotate edge-eu1           # rotate HMAC + Access token
polaris-email daemon deregister edge-eu1
```

The daemon refuses to start without a valid `registration.json`. Each daemon
has its own HMAC key in Workers Secrets and its own Cloudflare Access service
token (I18). Audit log records `daemon_id` per submission.

## DKIM rotation

```bash
# Per-domain (most-specific row gets a new key)
polaris-email domain rotate-dkim acme.com

# Zone-wide (all child domains using the wildcard inheritance rotate together)
polaris-email zone rotate-dkim acme.com
```

Rotation flow (A10):

1. New key generated; `dkim_keys` row inserted with `state='pending'`.
2. New DKIM CNAME published; `published → seen_via_authoritative → seen_via_three_resolvers`.
3. After confirmation, new key promoted: `state='active'`. Prior key →
   `state='retiring'`.
4. After 14-day flush window, retiring key removed from DNS.

If a step fails verification, rotation aborts and the prior active key
remains in service.

## Decommission a domain

```bash
polaris-email domain delete acme.com
```

State machine (H8):

`active → drained → off-boarded → routing-removed → mx-removed → dkim-removed → tombstoned`

Each transition requires DoH read-back proving the prior step actually took
effect on the public DNS before progressing. The `domains` row is tombstoned
(retained for audit) — never hard-deleted.

## Daily operations

- **Watch DLQ depth**: alert if `polaris-email status --queues` shows DLQ
  growth > 0 over a 5-min window.
- **Watch audit anchor age**: anchors run hourly; anchor age > 90 min is an
  alert (anchor service may be stuck).
- **Cost monitoring**: `polaris-email cost --month $(date +%Y-%m)` weekly;
  alert if Workers CPU-ms > 50% of subscription tier (I5 / I19 risk).

See `docs/RUNBOOK.md` for incident response procedures.
