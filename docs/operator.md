# polaris-email operator guide

Operator-facing documentation for running and maintaining a polaris-email
deployment. Pairs with `docs/runbook.md` (incident response) and
`docs/cost-model.md` (financial planning).

## Prerequisites

- Cloudflare account on the **Workers Paid** plan with Email Routing and Email
  Service available. Single account: `polaris-prod` (the previous
  three-account topology was collapsed; audit anchors moved
  off-Cloudflare to Backblaze B2).
- A **Backblaze B2 bucket** with Object Lock COMPLIANCE for audit anchors,
  plus a write-only Application Key. Setup steps live in
  [`infra/terraform/README.md`](../infra/terraform/README.md).
- `polaris-email` CLI installed: `brew install vladzaharia/tap/polaris-email`,
  or `go install github.com/vladzaharia/polaris-email/apps/polaris-cli/cmd/polaris-email@latest`,
  or download from GitHub Releases. The CLI is required for everything in
  this document.
- `terraform` 1.6+ for IaC managing DNS, Email Routing rules, Email Service
  onboarding, Cloudflare Access apps, and the R2 public custom domain.
- `wrangler` CLI for Workers/D1/KV/R2/Queues deploys.

### Cloudflare API token scopes

The `CF_API_TOKEN` set in `.env.deploy` (and pushed as a Worker secret) needs
the following scopes — broader than the original "just Email Routing on a
specific zone" model so the panel's `/cf-zones` discover view can list every
zone in the account:

- **Account → Email Routing → Edit** — required for `enable_routing`,
  catch-all rule writes, sender onboarding via Email Service.
- **Account → Workers Email Sending → Edit** — required for the new
  Email Service `/sender-domains` endpoint.
- **Account → Zone → Read** — required to list every zone in the account
  for the `/cf-zones` discover view.
- **Zone → Zone → Edit** — required when CF auto-publish falls back to
  manual DNS record creation (non-CF DNS edge case).
- **Zone → DNS → Edit** — same fallback scope.

`make preflight` checks both Email Routing and Zone:Read scopes and fails
loudly if either is missing.

## Bootstrap

There are two related but distinct bootstrap flows; pick based on what you
need:

- **`make bootstrap`** (this repo's `bin/bootstrap.sh`) — the cold-start
  Cloudflare provisioning path: D1 + KV + R2 + Queues, render
  `wrangler.local.jsonc` files, deploy every Worker, mint the first admin
  key. This is the canonical first step; see
  [`docs/deploy.md`](deploy.md) for the full sequence.
- **`polaris-email bootstrap --env prod`** (the CLI wizard) — interactive
  helper that wraps `make bootstrap` and additionally prompts for
  Terraform variables, validates the B2 anchor target, and saves a
  `terraform.tfvars` skeleton. Use it when you want a guided experience or
  are bootstrapping a brand-new operator environment.

Either way the flow is:

1. Reads CF account ID + scoped API token from prompt or `--from-file`.
2. Provisions D1 (single `polaris-email` database — sufficient at expected
   volume), 5 KV namespaces (nonce, idempotency, rate-limit, key-cache,
   revocations), the `polaris-email` R2 bucket (Object Lock COMPLIANCE), and
   5 Queues. The Backblaze B2 anchor bucket is **not** provisioned by this
   tool — bring it yourself per the prerequisites.
3. Runs schema migrations from `services/api/migrations/` (canonical
   `0001_init.sql`).
4. Deploys the four Workers (`services/api`, `services/out`,
   `services/in`) and the panel (`apps/panel`). The previous separate
   `services/fanout` + `services/cron` Workers were folded into
   `services/api`.
5. Mints the first operator API key with `admin:read` + `admin:audit:rotate`
   scopes, anchored as the genesis audit entry.
6. (CLI wizard only) Saves a `terraform.tfvars` skeleton you can fill in for
   the IaC pieces.

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

### A. Discover and configure CF zones (primary path)

The polaris-email panel and CLI now treat **Cloudflare as the source of
truth for what zones exist**. Instead of declaring "onboard this domain by
name", the operator picks from the live list of zones in their CF account
and asks polaris to converge each one to the canonical state.

**Panel (primary)** — open `/cf-zones`. Every zone in the operator's CF
account appears with six status badges: Routing enabled / DNS records
locked by CF / Sender onboarded / Catch-all → polaris-email-in / Named-rule
conflicts / D1 mailbox row. Click a zone → side panel showing the diff and
an `Apply` button gated on `withApproval('cf_zone.configure')`. The 5 already-
configured zones (`plrs.im`, `polaris.video`, `polaris.express`, `vlad.gg`,
`scruffy.spot`) should appear fully green.

**CLI (parity)**:

```bash
polaris-email cf-zone list                # all zones, status grid
polaris-email cf-zone status plrs.im      # detailed per-zone view
polaris-email cf-zone configure newdomain.com           # dry-run diff (default)
polaris-email cf-zone configure newdomain.com --apply   # actually apply
polaris-email cf-zone configure newdomain.com --apply --ops set_catch_all_worker  # subset
```

**What `configure` actually does**, in CF-first order:

1. **`enable_routing`** — POST `/zones/{id}/email/routing/enable`.
   Cloudflare auto-publishes the inbound MX records pointing at
   `route1/2/3.mx.cloudflare.net` and an SPF TXT record, locking them so
   subsequent edits go through CF.
2. **`set_catch_all_worker`** — PUT `/zones/{id}/email/routing/rules/catch_all`
   pointing at the `polaris-email-in` Worker.
3. **`onboard_sender_domain`** — POST `/accounts/{acc}/email-service/sender-domains`.
   CF auto-publishes the DKIM CNAMEs (with wildcard), SPF include for the
   `cf-bounce.<domain>`, DMARC, and the bounce MX. We DoH-verify after.
4. **`create_d1_mail_domain`** — INSERT a `mail_domains` row so polaris-email
   tracks the domain internally (used by sender lookups, send_email binding
   resolution, etc.).

Operator-defined named rules (e.g. `support@example.com → forward to ops@`)
are **listed in the status view but never modified**. The diff surfaces them
as warnings ("3 named rules will intercept mail before the catch-all") so the
operator can decide whether to clean them up via the CF dashboard.

### A1. Legacy: declarative `domain onboard` (deprecated)

The old `polaris-email domain onboard <name>` flow still works for the
edge case where the operator wants polaris-email to manage a domain that
isn't in the same CF account (e.g. a partner-owned zone with a one-off
delegation). Prefer `cf-zone configure` for everything else.

```bash
polaris-email domain onboard acme.com
```

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

`--mailbox` is the canonical flag (Phase 7b — the schema is mailbox-centric).
`--tenant` is accepted as a deprecated alias for one release with a warning
on stderr; new automation should use `--mailbox`.

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
polaris-email status --queues                  # queue + DLQ depths only
polaris-email auth verify --secret-file ./key  # offline HMAC sig check
wrangler tail polaris-email-out --status error --search "acme.com"   # outbound errors
wrangler tail polaris-email-in  --status error --search "acme.com"   # inbound errors
wrangler tail polaris-email-api --status error --search "webhook"    # webhook + cron failures (fanout + cron live in services/api)
polaris-email webhook dlq list
polaris-email webhook dlq inspect <id>
polaris-email webhook dlq replay <id>
polaris-email webhook dlq drop <id> --confirm <id>   # two-person rule
polaris-email audit verify                     # walk hash chain
polaris-email audit anchors                    # list B2 anchors (off-Cloudflare)
# Monthly bill: Cloudflare dashboard → Billing → Usage (no CLI command).
```

The `--queues` flag on `status` (Phase 7b) is the recommended fast path for
DLQ depth alerts — it skips the per-domain rollups and returns just the
inbound/outbound/fanout queue + DLQ depths. Pair it with the daily DLQ
watch in the section below.

`auth verify` (Phase 7b) reproduces the HMAC verification path used by the
control plane against a canonical-string + signature pair, useful when a
client reports `bad_signature` and you need to confirm whether the bug is
on the signer or the verifier. See `polaris-email auth verify --help`.

## Multi-host bridges

Mail bridges (Go binary `polaris-bridge`) accept SMTPS submission + serve IMAP
and forward to the API. Each bridge has its own identity:

```bash
polaris-email bridge register edge-eu1
# Returns docker-compose snippet + registration.json to deposit on the host.

polaris-email bridge list
polaris-email bridge rotate edge-eu1           # rotate HMAC + Access token
polaris-email bridge deregister edge-eu1 --confirm-name edge-eu1
```

`bridge deregister` requires `--confirm-name <name>` matching the bridge
name (Phase 7b). This is a fat-finger guard — there is no two-person rule
on bridge deregistration, so we make typos expensive instead.

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

Rotation flow:

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
  growth > 0 over a 5-min window. (`--queues` was added in Phase 7b for
  exactly this fast-path check.)
- **Watch audit anchor age**: anchors run hourly and land in Backblaze B2;
  anchor age > 90 min is an alert (anchor cron inside `services/api` may be
  stuck).
- **Cost monitoring**: review the Cloudflare dashboard Billing → Usage page weekly;
  alert if Workers CPU-ms > 50% of subscription tier (I5 / I19 risk).

See `docs/runbook.md` for incident response procedures.
