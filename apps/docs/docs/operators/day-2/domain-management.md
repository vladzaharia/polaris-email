---
title: Domain management
description: Discover and configure Cloudflare zones, onboard legacy domains, rotate DKIM, decommission. The CF-first path is canonical; declarative `domain onboard` is the fallback for off-account zones.
sidebar_label: Domain management
sidebar_position: 2
---

# Domain management

Two paths exist for getting a domain into polaris-email:

1. **CF zone discover + configure** (`polaris-email cf-zone configure`) —
   the canonical path when the zone lives in the same Cloudflare account
   as the control plane.
2. **Legacy declarative onboard** (`polaris-email domain onboard`) — the
   fallback for the edge case where the zone lives in a different CF
   account (e.g. a partner-owned zone with a one-off delegation).

Prefer the first path unless you have a specific reason not to.

## CF zone discover and configure

The polaris-email panel and CLI treat **Cloudflare as the source of
truth for what zones exist**. Instead of declaring "onboard this domain
by name", you pick from the live list of zones in your CF account and
ask polaris to converge each one to the canonical state.

### Panel (primary)

Open `/cf-zones`. Every zone in the operator's CF account appears with
six status badges:

1. Routing enabled
2. DNS records locked by CF
3. Sender onboarded
4. Catch-all → `polaris-email-in`
5. Named-rule conflicts
6. D1 `mail_domains` row

Click a zone → side panel showing the diff and an `Apply` button. The
panel gates destructive actions client-side via
`DestructiveActionDialog` (type-the-resource-name confirmation); the
audit log is the canonical record of who applied what.

### CLI (parity)

```sh
polaris-email cf-zone list                # all zones, status grid
polaris-email cf-zone list --refresh      # bypass the 60s server-side cache
polaris-email cf-zone status plrs.im      # detailed per-zone view
polaris-email cf-zone configure plrs.im              # dry-run diff (default)
polaris-email cf-zone configure plrs.im --apply      # actually apply
polaris-email cf-zone configure plrs.im --apply \
    --ops set_catch_all_worker            # subset (partial recovery)
```

A typical dry-run output:

```
Zone: plrs.im
Diff:
  - enable_routing: Enable Cloudflare Email Routing on plrs.im
  - set_catch_all_worker: Point catch-all rule at the polaris-email-in Worker
  - create_d1_mail_domain: Create polaris-email mail_domains row for plrs.im

Warnings:
  ! 2 named-address rule(s) on plrs.im route mail elsewhere

(dry run — pass --apply to actually configure)
```

`-o json` returns the raw envelope (`ZoneConfigureResult` for
`configure`, `CFZonesListResponse` for `list`, `ZoneDomainStatus` for
`status`) so you can pipe into `jq` or stash as an audit artefact.

### What `configure` actually does

In CF-first order:

1. **`enable_routing`** — `POST /zones/{id}/email/routing/enable`.
   Cloudflare auto-publishes the inbound MX records pointing at
   `route1/2/3.mx.cloudflare.net` and an SPF TXT record, locking them
   so subsequent edits go through CF.
2. **`set_catch_all_worker`** — `PUT /zones/{id}/email/routing/rules/catch_all`
   pointing at the `polaris-email-in` Worker.
3. **`onboard_sender_domain`** — `POST /accounts/{acc}/email-service/sender-domains`.
   CF auto-publishes the DKIM CNAMEs (with wildcard), SPF include for
   `cf-bounce.<domain>`, DMARC, and the bounce MX. We DoH-verify after.
4. **`create_d1_mail_domain`** — `INSERT` a `mail_domains` row so
   polaris-email tracks the domain internally (used by sender lookups,
   `send_email` binding resolution, etc.).

Operator-defined named rules (e.g. `support@example.com → forward to
ops@`) are **listed in the status view but never modified**. The diff
surfaces them as warnings ("3 named rules will intercept mail before
the catch-all") so you can decide whether to clean them up via the CF
dashboard.

### Required CF API token scopes

The `CF_API_TOKEN` secret on `services/api` needs:

- **Account → Email Routing → Edit**
- **Account → Workers Email Sending → Edit**
- **Account → Zone → Read** (account-wide — needed to enumerate every
  zone for the discover view)
- **Zone → Zone → Edit** (manual-DNS fallback)
- **Zone → DNS → Edit** (same fallback)

`polaris-email setup infra preflight` checks the Email Routing and
Zone:Read scopes and fails loudly if either is missing.

## Legacy: declarative `domain onboard`

The pre-CF-first flow still works for the edge case where the operator
wants polaris-email to manage a domain that isn't in the same CF
account (e.g. a partner-owned zone with a one-off delegation):

```sh
polaris-email domain onboard acme.com --inbound --outbound
# or fully interactive:
polaris-email domain onboard
# or non-interactive from a file:
polaris-email domain onboard --from-file domain.yaml
```

The wizard discovers the Cloudflare zone, publishes DKIM/SPF/DMARC +
MX, enables Email Routing, and registers the domain in the control
plane. By default a single `domains` row implicitly covers all
subdomains. Pass `--override` to register `mail.acme.com` explicitly
when its parent `acme.com` is already managed.

Bulk subdomain provisioning (PaaS workflow):

```sh
polaris-email domain bulk-onboard \
    --pattern 'tenant-{1..100}.app.example.com' \
    --zone example.com --outbound
```

## Verify and show

```sh
polaris-email domain list
polaris-email domain show acme.com
polaris-email domain verify acme.com
```

`domain verify` runs the same readiness check the panel surfaces —
DKIM, SPF, DMARC, MTA-STS, TLS-RPT records, plus the D1 row. The
`checks[]` array in the response calls out drift with names like
`mta-sts:operator-action:republish-policy`; each row's `actual` field
names the exact admin endpoint to call to remediate.

## DKIM rotation

```sh
# Per-domain (most-specific row gets a new key)
polaris-email domain rotate-dkim acme.com

# Zone-wide (all child domains using wildcard inheritance rotate together)
polaris-email zone rotate-dkim acme.com
```

Rotation flow:

1. New key generated; `dkim_keys` row inserted with `state='pending'`.
2. New DKIM CNAME published; transitions through
   `published → seen_via_authoritative → seen_via_three_resolvers`.
3. After confirmation, new key promoted: `state='active'`. Prior key →
   `state='retiring'`.
4. After 14-day flush window, retiring key removed from DNS.

If any step fails verification, rotation aborts and the prior active
key remains in service.

## Decommission a domain

```sh
polaris-email domain delete acme.com
```

State machine:

`active → drained → off-boarded → routing-removed → mx-removed → dkim-removed → tombstoned`

Each transition requires a DoH read-back proving the prior step
actually took effect on public DNS before progressing. The `domains`
row is tombstoned (retained for audit) — never hard-deleted.

## Inbound TLS hardening (MTA-STS + TLS-RPT)

RFC 8461 (MTA-STS) and RFC 8460 (TLS-RPT) record publishing runs
per-onboarded-domain. Senders that understand MTA-STS will require
valid TLS when delivering to Cloudflare's inbound MX
(`*.mx.cloudflare.net`) and report failures via TLS-RPT, giving you
first-class visibility into inbound TLS failures.

:::warning Manual provisioning
Unlike DKIM / SPF / DMARC — which Cloudflare auto-publishes when a
domain is onboarded — MTA-STS records require **explicit operator
action**. The admin endpoints below are the canonical way to publish
and revoke them. The verify flow detects drift and surfaces
`operator-action` hint rows when re-publishing is needed.
:::

### Admin endpoints

- `POST /v1/admin/domains/:id/mta-sts/enable`
- `POST /v1/admin/domains/:id/mta-sts/disable`
- `POST /v1/admin/domains/:id/mta-sts/promote` (testing → enforce)
- `POST /v1/admin/domains/:id/tls-rpt/enable`
- `POST /v1/admin/domains/:id/tls-rpt/disable`

### Default state on new domains

New domain rows are created with `mta_sts_mode='testing'` and
`tlsrpt_enabled=1`. These are _intent flags_ set on row creation; the
DNS records are NOT published until an operator (or
`bin/backfill-mta-sts.sh`) calls `/mta-sts/enable`. The intentional
two-phase shape lets you stage rollout per domain without surprising
fleet-wide DNS writes.

### Records published per domain on enable

Calling `/mta-sts/enable` publishes three records:

1. DNS `TXT` at `_mta-sts.{domain}` → `v=STSv1; id={policyId}`
2. Workers custom domain `mta-sts.{domain}` → `polaris-email-api` (the
   public policy handler serves the policy body at
   `https://mta-sts.{domain}/.well-known/mta-sts.txt`)
3. DNS `TXT` at `_smtp._tls.{domain}` → `v=TLSRPTv1; rua=mailto:tlsrpt@plrs.im`

`/tls-rpt/enable` publishes only record 3 (used when you opt into
reporting without yet publishing MTA-STS).

### Promotion ritual

```
enable (mode=testing) → wait ≥30 days → review TLS-RPT reports → promote (mode=enforce)
```

Promotion bumps `mta_sts_policy_id`, which forces sender-side caches
to refresh and pick up the stricter mode. Skipping the testing soak
risks silently breaking deliverability from misconfigured senders.

### Tools

- `bin/backfill-mta-sts.sh` — fleet enable for existing onboarded
  domains. Iterates verified, inbound-enabled domains where
  `mta_sts_mode='none'` and calls `/mta-sts/enable` +
  `/tls-rpt/enable` on each. Idempotent; safe to re-run.
- `bin/smoke-mta-sts.sh` — gated end-to-end probe. Requires
  `SMOKE_MTA_STS_DOMAIN_ID` env pointing at a real verified,
  MTA-STS-enabled domain. Designed for nightly CI on `main`.

### TLS-RPT mailbox

Reports land at `tlsrpt@plrs.im` by default (overridable per-domain
via `mail_domains.tlsrpt_rua`). Only the DNS record ships today; the
JSON-report ingestion / storage / alerting work is a follow-up phase,
so `tlsrpt@plrs.im` collects reports for manual inspection in the
meantime.

## Related runbooks

- [Operators](/operators) → Runbooks → `domain-onboarding` — on-call
  triage for failed onboards (lands in a later batch).
- [Data residency](/operators/runbooks/data-residency) — what
  per-domain data actually crosses borders.

<!-- Verified against: docs/operator.md @ c3c1b5048dd5bfe92facdce24982141a07446042 -->
