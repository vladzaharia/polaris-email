---
title: Routing and webhooks
description: Manage inbound routing rules (stored in routing_rules, dispatched by exact IDNA-normalised recipient match) and operate the webhook DLQ. Webhook signing happens in services/api's queue consumer.
sidebar_label: Routing and webhooks
sidebar_position: 5
---

# Routing and webhooks

Two related surfaces:

1. **Inbound routes** — `routing_rules` rows that the inbound Worker
   uses to dispatch a recipient to a webhook URL, drop, or forward.
2. **Webhook subscriptions and DLQ** — outbound webhook delivery from
   the queue consumer in `services/api`, plus the dead-letter queue
   for deliveries that exhausted retries.

The Cloudflare Email Routing rule is a single per-zone catch-all
pointing at the `polaris-email-in` Worker; all the named-pattern logic
lives in our code, not in CF.

## Inbound routing

### List, add, apply

```sh
polaris-email route list --domain acme.com
polaris-email route add --domain acme.com \
    --pattern 'support@acme.com' --action webhook --url https://...
polaris-email route apply -f routes.yaml      # declarative reconciliation
```

A typical `routes.yaml`:

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

`route apply` is a declarative reconciler: it computes the diff between
the file and the current `routing_rules` rows for the named domains
and emits a transactional batch of inserts / updates / deletes. Pass
`--dry-run` to print the diff without applying it.

### Enable, disable, update

```sh
polaris-email route disable <id>
polaris-email route enable  <id>
polaris-email route update  <id> --url https://new-host/email-hook
```

Disabled routes stay in `routing_rules` but are skipped during
dispatch. Use `disable` for short-term debugging; use `delete` (via
`apply` with the row removed from the YAML) for permanent removal.

### How dispatch works

The inbound Worker (`services/in`) reads every catch-all hit from
Cloudflare Email Routing, parses the recipient list, and dispatches by
**exact IDNA-normalised recipient match** against the `routing_rules`
set for the recipient's domain. Pattern matching is intentionally
strict — wildcards (`support@*`) match the local-part wildcard
literally, not any other pattern grammar.

If no route matches, the inbound Worker falls back to mailbox lookup
(via `mailbox_receivers`) and delivers to the owning mailbox's webhook
subscriptions.

## Webhook subscriptions

Webhook subscriptions are per-mailbox. CRUD lives on the admin REST
surface (`POST /v1/admin/mailboxes/:id/webhook-subs`) or the panel UI.

:::warning Out of date
The CLI does not yet expose a `webhook subs` verb. `polaris-email
webhook` is currently the DLQ surface only; subscription CRUD runs
through the admin REST surface or the panel. CLI parity is intentional
follow-up.
:::

Each subscription has its own HMAC secret used to sign outgoing webhook
deliveries with the `polaris-webhook` domain tag — see the
[HMAC reference](/security/hmac-reference) for the canonical spec.
Subscriptions also carry an optional event filter. The queue consumer
in `services/api` (`src/queue/fanout.ts`) is the **only place outgoing
webhooks are signed**; the webhook envelope is v2 (the full `Message`
is inlined).

## Webhook DLQ

Failed webhook deliveries — those that exhausted the retry schedule —
land in a dead-letter queue. The DLQ is operator-managed: nothing
moves out without explicit action.

```sh
polaris-email webhook dlq list
polaris-email webhook dlq inspect <id>
polaris-email webhook dlq replay <id>
polaris-email webhook dlq drop <id> --confirm <id>
```

- **`list`** prints DLQ rows with attempt counts, last-error codes,
  and target webhook IDs.
- **`inspect`** fetches the row's full envelope (the signed v2 webhook
  body), the response headers from each attempt, and the failure
  classification.
- **`replay`** re-enqueues the row onto the fanout queue. The queue
  consumer signs the new attempt with the **current** secret — if the
  webhook secret rotated since the original attempt, `replay` uses the
  new secret.
- **`drop`** permanently removes the row. The `--confirm <id>` flag
  must repeat the row id back; a fat-finger drop is intentionally hard.

Watch DLQ depth via `polaris-email status --queues` (see
[Activity inspection](/operators/day-2/activity-inspection)); a
growing DLQ is the on-call signal for the
[webhook-dlq runbook](/operators/runbooks/webhook-dlq).

## Webhook signing reference

Outgoing webhook deliveries are signed by the queue consumer with a
canonical-string of:

```
direction\nmethod\npath\ncanonical-query\nts\nnonce\nsha256-hex-of-body
```

`direction` is the literal string `polaris-webhook`. The signature
header is `X-Polaris-Sig: <lowercase-hex>` — no `v1=` / `v2=` prefix.
Constant-time compare on the receiving side.

The Node SDK (`@polaris/sdk/webhook`) and Go SDK (`polaris-sdk-go`)
both ship verifiers that match the test vectors under
[`packages/test-vectors/vectors.json`](https://github.com/vladzaharia/polaris-email/blob/main/packages/test-vectors/vectors.json).
See the [HMAC reference](/security/hmac-reference) for the full spec.

## Related runbooks

- [Webhook DLQ](/operators/runbooks/webhook-dlq) — on-call response to
  DLQ growth.
- [Domain management](/operators/day-2/domain-management) — when
  inbound routes fail because the domain isn't fully onboarded.

<!-- Verified against: docs/operator.md @ c3c1b5048dd5bfe92facdce24982141a07446042 -->
