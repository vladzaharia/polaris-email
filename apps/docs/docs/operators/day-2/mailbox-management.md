---
title: Mailbox management
description: Mailboxes are the unit of routing, auth scope, retention, and webhook delivery. Manage them via the admin REST surface or the panel; CLI parity is intentional follow-up.
sidebar_label: Mailbox management
sidebar_position: 3
---

# Mailbox management

polaris-email is **mailbox-centric**: each operator owns N mailboxes,
and a mailbox is the unit of routing, auth scope, retention, and
webhook delivery. Every message — inbound or outbound — has exactly
one `mailbox_id`. The previous tenant-centric model is gone; any
`--tenant` flag the CLI still accepts is a deprecated alias.

## What a mailbox owns

Each mailbox row hangs off four child tables:

- **`mailbox_senders`** — addresses the mailbox may send `from`.
  Validated on every outbound submission.
- **`mailbox_receivers`** — addresses the mailbox claims for inbound.
  The inbound Worker dispatches by exact IDNA-normalised recipient
  match against this set.
- **`principals`** — API keys and SMTP/IMAP credentials scoped to the
  mailbox. Plaintext is shown exactly once at issuance.
- **`webhook_subs`** — webhook subscriptions that fan out events for
  the mailbox.

Per-mailbox `mail_domains` rows also live on the mailbox (an
operator-owned domain can be claimed by exactly one mailbox).

See [Operators](/operators) → Concepts → Architecture (lands in a
later batch) for the schema diagram.

## Create, list, show, delete

:::warning Out of date
The CLI does not yet expose a `mailbox` verb domain. Mailbox CRUD runs
through the admin REST surface (`POST /v1/admin/mailboxes`,
`GET /v1/admin/mailboxes`, `GET /v1/admin/mailboxes/:id`,
`DELETE /v1/admin/mailboxes/:id`) or the panel UI. The panel is the
easiest path; CLI parity is intentional follow-up.
:::

### Via the panel

The panel's `/mailboxes` view lists every mailbox with its sender /
receiver / principal / webhook-sub counts. The detail page exposes the
four child tables inline and gates destructive actions
(delete-mailbox, mass-revoke-credentials) via the
`DestructiveActionDialog` (type-the-resource-name confirmation).

### Via the admin REST surface

```sh
# Create
curl -X POST "$API/v1/admin/mailboxes" \
    -H "X-Polaris-Sig: $(polaris-email auth sign --method POST --path /v1/admin/mailboxes --body req.json)" \
    --data-binary @req.json

# List
curl -X GET "$API/v1/admin/mailboxes" \
    -H "X-Polaris-Sig: $(polaris-email auth sign --method GET --path /v1/admin/mailboxes)"
```

See [Reference](/reference) → API for full request / response shapes
and required headers; the signing canonical-string is the same one
documented in [Security](/security) → HMAC reference (lands in a
later batch).

## Once a mailbox exists

Other day-2 workflows are mailbox-scoped:

- **Senders and receivers** — attached at credential-issuance time via
  `polaris-email cred issue --mailbox <id> --senders <list>`; see
  [Credential management](/operators/day-2/credential-management).
- **Inbound routes** — `polaris-email route` commands target a
  `--domain`, and the inbound Worker resolves the recipient back to the
  owning mailbox; see
  [Routing and webhooks](/operators/day-2/routing-and-webhooks).
- **Webhook subs** — managed under the same routing-and-webhooks page
  (admin REST surface today, panel UI for the common case).
- **Activity inspection** — `polaris-email status` rolls up per-domain
  and per-mailbox counters; see
  [Activity inspection](/operators/day-2/activity-inspection).

## `--mailbox` is canonical; `--tenant` is deprecated

The schema is mailbox-centric. CLI commands accept `--mailbox <id>` as
the canonical flag.

:::warning Deprecated
`--tenant` is accepted as a deprecated alias for one release and
prints a warning on stderr. The alias will be removed in a future
release. Update any automation that still uses `--tenant` now;
new scripts should use `--mailbox` exclusively.
:::

Any older runbook or wiki page that still references `tenant_id` is
talking about the same row shape under the new schema — it points at
what we now call a mailbox.

## Related runbooks

- [Operators](/operators) → Runbooks → `credential-rotation` — the
  on-call playbook when a mailbox's keys are compromised (lands in a
  later batch).
- [Retention and cleanup](/operators/runbooks/retention-and-cleanup) —
  what a mailbox-scoped retention bucket actually deletes.

<!-- Verified against: docs/operator.md @ c3c1b5048dd5bfe92facdce24982141a07446042 -->
