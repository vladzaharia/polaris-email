---
title: Get started
description: Land here to send your first message or stand up your first deployment. Two entry points — pick the one that matches your role.
sidebar_label: Overview
sidebar_position: 0
---

# Get started with polaris-mail

Two doors. Pick the one that matches what you're trying to do today.

## Stand up a new deployment (operator)

You have a Cloudflare account and you want a working control plane.

→ **[30-minute first deploy](/get-started/30-min-first-deploy)** —
the hero tutorial. Zero to your first authenticated send in roughly
half an hour. Covers CF token scopes, `polaris-mail setup infra`
end-to-end, the genesis seal, minting a first credential, and three
flavors of test send (curl, Node SDK, Go SDK).

When the tutorial wraps, the next pages to read are the
[Cloudflare Access walkthrough](/operators/deployment/cloudflare-access)
(to lock down the panel) and the
[monitoring page](/operators/day-2/monitoring) (to wire SLOs +
`ALERT_WEBHOOK` into Slack / PagerDuty).

## Send your first message (developer)

The operator already stood the service up and issued you a key. You
want to `POST /v1/messages` and see the webhook fire.

→ **[5-minute quickstart](/developers/quickstart)** — sign a
request, send a test message, verify a webhook signature. TypeScript,
Go, and raw `curl` recipes for both `application/json` and
`message/rfc822` content types.

The companion pages are the
[error catalog](/reference/errors) (every code your client will see)
and the [unified Message model](/developers/messages/unified-model)
(the shape of the webhook envelope).

## Looking for something else?

- **Concepts**: the [mail-bridge concept page](/operators/concepts/mail-bridge)
  and the [cost model](/operators/concepts/cost-model) cover the
  parts most operators want to read first.
- **Operator runbooks**: the [on-call runbook](/operators/runbooks)
  is the 3-AM reference; the
  [troubleshooting decision matrix](/operators/troubleshooting/decision-matrix)
  indexes the same content by symptom.
- **Security model**: the [threat model](/security/threat-model) is
  required reading before changing anything that touches HMAC,
  R2 public URLs, or the audit chain.
- **CLI reference**: the full subcommand surface is in
  [`reference/cli`](/reference/cli).
