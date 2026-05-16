# polaris-email operator guide

Operator-facing documentation for running and maintaining a polaris-email
deployment. Pairs with `docs/runbook.md` (incident response) and
`docs/cost-model.md` (financial planning).

## Prerequisites

- Cloudflare account on the **Workers Paid** plan with Email Routing and Email
  Service available.
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
2. Provisions D1 (single `polaris-email` database. Earlier revisions
   was rolled back; one DB is sufficient at expected volume), KV
   namespaces, R2 buckets (including the anchors bucket
   in the `polaris-anchors` account with object lock in compliance mode), and
   Queues.
3. Runs schema migrations from `services/api/migrations/` (canonical
   `0001_init.sql`).
4. Deploys the control-plane Workers (`services/api`, `services/out`,
   `services/in`, `services/fanout`, `services/cron`) and the panel
   (`apps/panel`).
5. Mints the first operator API key with `admin:read` + `admin:audit:rotate`
   scopes, anchored as the genesis audit entry.
6. Saves a `terraform.tfvars` skeleton you can fill in for the IaC pieces.

## Mailbox-centric routing

polaris-email is mailbox-centric: each operator owns N **mailboxes**, and a
mailbox is the unit of routing, auth scope, retention, and webhook
delivery. A mailbox owns its `mailbox_senders` (addresses it may send
from), `mailbox_receivers` (addresses it claims for inbound), `principals`
(API keys / SMTP credentials), and `webhook_subs`. Every message — inbound
or outbound — has exactly one `mailbox_id`.

Inbound routing matches incoming MIME recipients against
`mailbox_receivers` patterns; outbound submission resolves the mailbox via
the principal's binding, then validates the requested `from` against
`mailbox_senders`. The previous tenant-centric model is gone; CLI commands
referenced below that still say "tenant" target the same row shape under
the new schema.

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

### B. Manage mailboxes

The schema is mailbox-centric (see `docs/architecture.md`). Mailboxes are the unit
of routing, auth scope, retention, and webhook delivery. Manage them via the admin
REST surface (`POST /v1/admin/mailboxes`) — the panel is the easiest place to do
this; there is no CLI subcommand specifically for mailbox CRUD today.

Each mailbox owns its senders, receivers, principals (API keys / SMTP creds), and
webhook subscriptions. Senders are attached via `polaris-email cred issue
--mailbox <id> --senders <list>` (see C).

### C. Manage credentials

```bash
# API key for REST send
polaris-email cred issue --mailbox <mailbox-id> --type api \
    --senders "noreply@acme.com,alerts@mail.acme.com" \
    --output secret-file --output-path ./newsletter-api.key

# SMTP credential for legacy clients
polaris-email cred issue --mailbox <mailbox-id> --type smtp \
    --senders "noreply@acme.com" \
    --output json   # for piping to op/pass

# List, revoke, rotate
polaris-email cred list --mailbox <mailbox-id>
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
wrangler tail polaris-email-out --status error --search "acme.com"   # outbound errors
wrangler tail polaris-email-in --status error --search "acme.com"    # inbound errors
wrangler tail polaris-email-api --status error --search "webhook"    # webhook failures
polaris-email webhook dlq list
polaris-email webhook dlq inspect <id>
polaris-email webhook dlq replay <id>
polaris-email webhook dlq drop <id> --confirm <id>   # two-person rule
polaris-email audit verify                     # walk hash chain
polaris-email audit anchors                    # list R2 anchors
# Monthly bill: Cloudflare dashboard → Billing → Usage (no CLI command).
```

## Multi-host bridges

Mail bridges (Go binary `polaris-bridge`) accept SMTPS submission + serve IMAP
and forward to the API. Each bridge has its own identity:

```bash
polaris-email bridge register edge-eu1
# Returns docker-compose snippet + registration.json to deposit on the host.

polaris-email bridge list
polaris-email bridge rotate edge-eu1           # rotate HMAC + Access token
polaris-email bridge deregister edge-eu1
```

The bridge refuses to start without a valid `registration.json`. Each bridge
has its own HMAC key in Workers Secrets and its own Cloudflare Access service
token (I18). Audit log records `bridge_id` per submission.

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

## Inbound TLS hardening (MTA-STS + TLS-RPT)

Phase C adds RFC 8461 (MTA-STS) and RFC 8460 (TLS-RPT) record publishing per
onboarded domain. Senders that understand MTA-STS will require valid TLS when
delivering to Cloudflare's inbound MX (`*.mx.cloudflare.net`) and report
failures via TLS-RPT, giving us first-class visibility into inbound TLS
failures.

### Architectural note: manual provisioning

Unlike DKIM / SPF / DMARC — which Cloudflare auto-publishes when a domain is
onboarded to Email Routing / Email Service — MTA-STS records require
**explicit operator action**. The admin endpoints below are the canonical way
to publish and revoke them. The verify flow detects drift and surfaces
`operator-action` hint rows when re-publishing is needed.

Admin endpoints:

- `POST /v1/admin/domains/:id/mta-sts/enable`
- `POST /v1/admin/domains/:id/mta-sts/disable`
- `POST /v1/admin/domains/:id/mta-sts/promote` (testing → enforce)
- `POST /v1/admin/domains/:id/tls-rpt/enable`
- `POST /v1/admin/domains/:id/tls-rpt/disable`

### Default state on new domains

New domain rows are created with `mta_sts_mode='testing'` and
`tlsrpt_enabled=1`. These are _intent flags_ set on row creation, but **the
actual DNS records are NOT published until** an operator (or
`bin/backfill-mta-sts.sh`) calls `/mta-sts/enable`. This intentional
two-phase shape lets operators stage rollout per domain without surprising
fleet-wide DNS writes.

### Records published per domain on enable

Calling `/mta-sts/enable` publishes three records:

1. DNS `TXT` at `_mta-sts.{tenant}` → `v=STSv1; id={policyId}`
2. Workers custom domain `mta-sts.{tenant}` → `polaris-email-api` (the
   public policy handler from C.9, which serves the policy body at
   `https://mta-sts.{tenant}/.well-known/mta-sts.txt`)
3. DNS `TXT` at `_smtp._tls.{tenant}` → `v=TLSRPTv1; rua=mailto:tlsrpt@plrs.im`

`/tls-rpt/enable` publishes only record 3 (used when an operator opts into
reporting without yet publishing MTA-STS).

### Promotion ritual

```
enable (mode=testing) -> wait >= 30 days -> review TLS-RPT reports -> promote (mode=enforce)
```

Promotion bumps `mta_sts_policy_id`, which forces sender-side caches to
refresh and pick up the stricter mode. Skipping the testing soak risks
silently breaking deliverability from misconfigured senders.

### Drift detection

`POST /v1/admin/domains/:id/verify` returns a `checks[]` array. Drift surfaces
as rows with names like `mta-sts:operator-action:republish-policy` or
`tls-rpt:operator-action:republish-rua`, and each row's `actual` field
names the exact admin endpoint to call to remediate. The panel's domain
detail page highlights these rows (C.13).

### Tools

- `bin/backfill-mta-sts.sh` — fleet enable for existing onboarded domains.
  Iterates verified, inbound-enabled domains where `mta_sts_mode='none'` and
  calls `/mta-sts/enable` + `/tls-rpt/enable` on each. Idempotent; safe to
  re-run.
- `bin/smoke-mta-sts.sh` — gated end-to-end probe. Requires
  `SMOKE_MTA_STS_DOMAIN_ID` env pointing at a real verified, MTA-STS-enabled
  domain. Designed for nightly CI on `main`.

### TLS-RPT mailbox

Reports land at `tlsrpt@plrs.im` by default (overridable per-domain via
`mail_domains.tlsrpt_rua`). Phase C ships only the DNS record. Report
ingestion — parsing the JSON reports, storage, and alerting — is a
follow-up phase; for now `tlsrpt@plrs.im` simply collects reports for
manual inspection.

## Daily operations

- **Watch DLQ depth**: alert if `polaris-email status --queues` shows DLQ
  growth > 0 over a 5-min window.
- **Watch audit anchor age**: anchors run hourly; anchor age > 90 min is an
  alert (anchor service may be stuck).
- **Cost monitoring**: review the Cloudflare dashboard Billing → Usage page weekly;
  alert if Workers CPU-ms > 50% of subscription tier (I5 / I19 risk).

See `docs/runbook.md` for incident response procedures.
