---
title: DKIM, DMARC, SPF
description: What polaris-mail publishes for each verified outbound domain, why those defaults, alignment rules, and what to do when authentication fails — plus inbound TLS hardening via MTA-STS and TLS-RPT.
sidebar_label: DKIM / DMARC / SPF
sidebar_position: 4
---

# Email authentication (DKIM / DMARC / SPF) and inbound TLS

This page is the canonical reference for what DNS polaris-mail
publishes on a verified outbound domain, why those defaults are what
they are, and how to triage auth failures. The corresponding day-2
workflow — verify, rotate, troubleshoot from the operator side —
lands under [Operators](/operators) → Day 2 → Domain management in a
later batch.

## What polaris-mail publishes

For a domain with `capabilities.outbound = true`, polaris-mail
publishes (or expects to find) three DNS records via Cloudflare Email
Service onboarding (`packages/cf-api/src/email-service.ts`, invoked
by the admin API during `POST /v1/admin/domains` and `polaris-mail
domain onboard`). The `_dmarc.<domain>` TXT is owned and managed by
Cloudflare DMARC Management, not polaris (see below).

### DKIM CNAME — `polaris1._domainkey.<domain>` → CF Email Service

```text
polaris1._domainkey.<domain>.   CNAME   polaris1.<domain>.dkim.cfemail.net.
```

- The control-plane domain-create handler defaults to selector **`cf`**
  when no selector is supplied
  (`services/api/src/routes/admin/domains.ts`). Rotation can mint
  successor selectors (`polaris1` → `polaris2` → …) via
  `polaris-mail domain rotate-dkim`; both selectors point at
  CF Email Service-managed keys.
- The private key never lives on polaris infrastructure — Cloudflare
  Email Service holds it and signs at send time. Rotation is performed
  by minting a new selector (`polaris1` → `polaris2`) via
  `polaris-mail domain rotate-dkim`; the old selector keeps verifying
  in-flight mail until you take it down.
- If `include_dkim_wildcard = true`, a `*._domainkey.<domain>` CNAME is
  also published so subdomain mail validates without per-subdomain
  records. Defaults to **off**; most operators do not want this.

### SPF TXT — `<domain>`

```text
<domain>.   TXT   "v=spf1 include:_spf.mx.cloudflare.net -all"
```

- The Email Service onboarding path emits `-all` (hard fail). Prefer
  `-all` when polaris-mail is the only outbound source for the
  domain; if you also send through hand-rolled paths, replace the
  record manually after onboarding with `~all` (soft fail).

### DMARC — managed by Cloudflare DMARC Management

polaris-mail no longer publishes its own `_dmarc.<domain>` TXT record.
Cloudflare DMARC Management is enabled per-zone during domain
onboarding (`packages/cf-api/src/dmarc-management.ts:enableDmarcManagement`,
called automatically by `onboardSenderDomain`), and Cloudflare
publishes the `_dmarc` record, ingests aggregate reports on its side,
and surfaces the data via GraphQL Analytics (`dmarcReportsAdaptive`
+ `dmarcReportsSourcesAdaptiveGroups`).

polaris-mail mirrors per-(domain, day) aggregates from CF into the
`dmarc_alignment_rollup` D1 table nightly
(`services/api/src/scheduled/dmarc-mirror.ts`, cron `0 2 * * *`).
The auto-promotion cron at `0 4 * * *` reads the rollup and walks the
soak state machine; when it advances into a write state it calls
`setDmarcPolicy` on CF DMARC Management rather than publishing DNS
directly.

Operators can advance manually from the panel ("Advance now" on the
domain detail page) or via
`POST /v1/admin/dmarc-promotion/:id/advance` (scope `admin:rotate`).
Both paths issue the same CF API call; CF re-publishes the `_dmarc`
TXT with the new `p=` value.

### Bounce MX — `cf-bounce.<domain>`

```text
cf-bounce.<domain>.   MX 10   route.mx.cloudflare.net
```

Required for outbound; routes upstream bounces back to the CF Email
Service bounce processor.

## Why quarantine, not reject

Default `p=quarantine` is intentional. The promotion path is:

1. **`p=none`** — monitoring only. Aggregate reports flow; receivers
   ignore policy. Use this for at least 7 days on a new domain to
   surface any forgotten legacy outbound sources.
2. **`p=quarantine`** — failing mail lands in spam. This is the
   default polaris-mail ships **after** the operator confirms the
   monitoring window is clean. Most legitimate clients still see the
   mail (just in spam); a misconfiguration costs deliverability, not
   the message itself.
3. **`p=reject`** — failing mail is dropped. Terminal state. Only
   advance here once aggregate reports show zero unauthenticated
   sources for a sustained window. Reversing a misfire takes a DNS
   TTL plus receiver cache time; do not advance lightly.

The DMARC promotion runbook in `services/api/src/routes/admin/dmarc-promotion.ts`
gates the `quarantine → reject` advance behind a minimum observation
window and a zero-fail-rate check from aggregate reports.

## Why SPF `-all`

`-all` is what Cloudflare's onboarding publishes and what
polaris-mail's REST onboarding emits. If you operate non-polaris
outbound paths for the same domain during a migration window, replace
the record manually with `~all` (softfail) and revert to `-all` once
those paths are decommissioned.

The cost of `-all` over `~all` is zero for receivers that respect SPF
strictly; the benefit is that `-all` failures are unambiguously bad
mail, not "softfail but maybe deliver".

## Alignment

Outbound mail is authenticated by **DKIM** and authorised by **SPF**.
DMARC requires alignment between the `From:` domain and one of the
two:

- **DKIM alignment** — the `d=` tag on the DKIM signature must match
  (or be a registered-domain match for) the `From:` domain. Strict by
  default; the polaris-mail DKIM signer uses `d=<from-domain>` so
  strict alignment passes for any `From:` on a verified domain.
- **SPF alignment** — the `MAIL FROM:` (envelope sender) domain must
  match the `From:` domain. The CF bounce MX path uses
  `cf-bounce.<domain>`, which is on the same registered domain as the
  `From:`, so **relaxed** SPF alignment passes; **strict** alignment
  would not.

DMARC's `aspf=` and `adkim=` tags default to `r` (relaxed) and that is
what polaris-mail relies on. If you publish `aspf=s` you will break
SPF alignment for polaris-sent mail; do not.

## Triage: what to do on auth failure

| Failure                                                | First check                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **SPF fail** at the receiver                           | Confirm the SPF TXT is published and resolves to the polaris-mail value. Verify with `dig +short TXT <domain>`. If it's missing or has a hand-rolled record without the CF include, re-run the domain verify path.                                                                                           |
| **DKIM fail** at the receiver                          | Check which selector signed the message (`Authentication-Results` header → `header.s=<selector>`). Confirm `<selector>._domainkey.<domain>` CNAME resolves. If you rotated recently, check that the **old** selector is still in DNS — receivers may have cached the old key.                                |
| **DMARC fail** with SPF+DKIM pass on different domains | This is an alignment failure, not an auth failure. Confirm the `From:` domain matches the DKIM `d=` tag. If a downstream forwarder rewrote `From:`, the originally-aligned DKIM no longer aligns post-forward — that's the forwarder's problem, not yours, but ARC sealing on the forwarder is the only fix. |
| **DMARC fail** with SPF+DKIM fail                      | Real auth failure. Walk the SPF and DKIM rows above.                                                                                                                                                                                                                                                         |

For the operator-side rotation flow:

```sh
polaris-mail domain rotate-dkim <domain>     # mints new selector, publishes CNAME
```

Inspect the current state via the panel or:

```sh
polaris-mail domain show <domain>
```

The `last_verify_check_at` column reflects the last successful DNS
verify run. A failed verify will not block sends, but the panel will
flag the domain.

## Inbound TLS hardening — MTA-STS and TLS-RPT

Per-domain MTA-STS and TLS-RPT records are **opt-in**, not part of the
default DKIM/SPF/DMARC bundle. They control how remote senders MUST
deliver to your inbound MX (TLS-only, with hostname validation).

Publishing flow:

```sh
polaris-mail domain enable-mta-sts <domain>      # publishes _mta-sts TXT + mta-sts.<domain> Worker custom domain
polaris-mail domain enable-tls-rpt <domain>      # publishes _smtp._tls TXT pointing at the platform aggregator
```

Under the hood:

- The `_mta-sts.<domain>` TXT advertises a policy ID; the
  `mta-sts.<domain>` Worker custom domain serves the policy document
  at `https://mta-sts.<domain>/.well-known/mta-sts.txt`.
- The policy can be in **testing** or **enforce** mode. Default on
  publish is `testing` — receivers log TLS failures but do not bounce.
  Promote to `enforce` once TLS-RPT shows zero failures for a
  sustained window.
- TLS-RPT (`_smtp._tls.<domain>` TXT) directs receivers to send
  aggregate TLS reports to a platform-managed aggregator. Reports land
  in `tls_rpt_reports` and the panel surfaces them.

The two records are managed separately from DKIM/SPF/DMARC because
the DKIM/SPF/DMARC records are emitted by the Cloudflare Email
Service onboarding path (idempotent, no operator action beyond domain
create) while MTA-STS requires a Worker custom-domain provisioning
step that polaris-mail does not perform implicitly. The
domain-handler returns `mta_sts_provisioning_hint` and
`tlsrpt_provisioning_hint` on create to make the explicit
post-create call visible.

If the records ever drift (operator hand-edit, dashboard fight, TTL
expiry on the Worker custom domain), re-run the enable command — it
is idempotent and re-publishes the canonical state.

## Out of scope

- **BIMI**. Not published, not validated, not on the v1 roadmap.
- **DKIM key length / algorithm**. Cloudflare Email Service owns the
  key material — polaris-mail does not select the algorithm or
  length, just CNAMEs the selector at the CF-managed target.

<!-- Verified against: services/api/src/routes/admin/domains.ts, services/api/src/routes/admin/domains-mta-sts.ts, packages/cf-api/src/email-service.ts (expectedRecordsFor), services/api/migrations/0015_dmarc_reports.sql, services/api/migrations/0016_dmarc_promotion.sql @ eeee222cdf8359f8f2bf1013a103abdb3c705f06 -->
