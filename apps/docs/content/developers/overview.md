---
title: For developers
description: SDKs (Node, Go), HMAC signing, the unified Message model, webhook delivery, and end-to-end recipes for outbound submission and inbound event handling.
sidebar_label: Overview
sidebar_position: 0
---

# Developer documentation

You are integrating with polaris-email — sending mail, receiving webhooks,
or both. Pick the entry point that matches what you have today.

## Send your first message

→ **[Quickstart](/developers/quickstart)** — sign a request, hit
`POST /v1/messages`, verify the webhook. TypeScript, Go, and raw `curl`
recipes for both `application/json` and `message/rfc822` content types.

## Sign requests by hand

→ **[HMAC concept](/developers/authentication/concept)** — what gets
signed, the four request headers, the ±5-minute skew window, and why
the idempotency key is a separate thing from the nonce.

→ **[HMAC reference](/security/hmac-reference)** — the formal
canonical-string spec, byte-by-byte, for implementing a verifier from
scratch.

## Use a first-party SDK

| Language | Page                                      |
| -------- | ----------------------------------------- |
| Node     | [`@polaris/sdk`](/developers/sdks/node)   |
| Go       | [`polaris-sdk-go`](/developers/sdks/go)   |
| Other    | [REST + curl](/developers/sdks/rest-curl) |

Both first-party SDKs ship a signer, retry-on-`key_propagating` logic, a
webhook verifier, and typed errors.

## Read inbound mail

→ **[Webhook decision tree](/developers/webhooks/decision-tree)** — pick
external HTTPS, tailnet, or bridge-proxied delivery based on where your
consumer service sits.

→ **[Subscription lifecycle](/developers/webhooks/lifecycle)** — create,
scope, verify, retry, dedupe, rotate, disable.

→ **[Unified Message model](/developers/messages/unified-model)** — the
single `Message` shape that backs inbound and outbound mail, the v2
webhook envelope, and the R2 public custom domain.

## SMTPS / IMAP from a legacy client

→ **[SMTP cookbook](/developers/smtp-cookbook)** — Nodemailer, PHPMailer,
Go `net/smtp`, JavaMail, sendmail / msmtp. Implicit TLS on `:465`, IMAP
on `:993` against the on-prem [mail bridge](/operators/concepts/mail-bridge).

## When something goes wrong

→ **[Error catalog](/reference/errors)** — every wire code with HTTP
status, retryability, and a recovery hint.

→ **[Consumer contract](/reference/consumer-contract)** — the stability
promises polaris-email makes you.
