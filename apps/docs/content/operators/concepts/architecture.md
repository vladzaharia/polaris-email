---
title: Architecture
description: The operator's system view — three Cloudflare Workers, one D1 database, mailbox-centric schema, a unified pipeline, and the chained-hash audit log on a single CF account.
sidebar_label: Architecture
sidebar_position: 1
---

# polaris-email architecture

The operator's system view. This page answers "what runs where, what
stores what, and what fails if I unplug it" — not "where is the code".
For codebase navigation see [Contributing](/contributing) → Architecture
deep-dive.

## Three Workers, one account, one database

The entire control plane runs in **one Cloudflare account** across three
Workers. The panel runs as a fourth Worker but is operationally a client
of the API.

| Worker  | Role                                                                                                                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api`   | The REST surface. **Also** hosts the webhook fan-out queue consumer and every cron trigger — weekly secret staleness check, 5-minute health synthetic, nightly retention janitor, nightly audit-chain verify, weekly D1 export. |
| `in`    | Email Routing handler. Parses inbound MIME, runs the unified pipeline, persists.                                                                                                                                                |
| `out`   | Outbound queue consumer. Drives the configured provider (Cloudflare `send_email` binding per domain).                                                                                                                           |
| `panel` | Admin UI (Hono + React, sessions in D1). Talks to `api` via a service binding, not a public fetch. Not in the mail path.                                                                                                        |

Three mail-path Workers, not five. The previous separate `fanout` and
`cron` Workers were folded into `api`, and the `forensic` Worker was
removed when the schema went zero-payload-by-default. There is no reason
to bring them back at the deployment scale polaris-email targets
(< 10k msg/day).

Tamper-evidence comes from the in-row chained-hash invariant on
`audit_log` plus the nightly `audit-verify` cron — see
[Audit chain integrity](#audit-chain-integrity) below.

## Mailbox-centric data model

The schema is rooted at `mailboxes`. Every other operational entity hangs
off a mailbox:

```
operator
  └── mailboxes (1..N)
        ├── mailbox_senders     — addresses this mailbox can send as
        ├── mailbox_receivers   — addresses this mailbox claims for inbound
        ├── principals          — API keys / SMTP creds bind to a mailbox
        │     └── principal_sender_scopes
        ├── webhook_subs        — per-mailbox event subscriptions
        └── messages            — inbound and outbound; `direction` discriminates
```

A mailbox is the unit of routing, auth scope, retention, and webhook
delivery. Every message has exactly one `mailbox_id`. Inbound mail is
matched to a mailbox by walking `mailbox_receivers` patterns; outbound
mail is matched by the principal's mailbox plus the requested `from`
address's presence in `mailbox_senders`.

Any `tenant` terminology you see in legacy tooling is alias plumbing
(warn-only in the CLI). The unit of authority is the mailbox.

## Unified pipeline

A single pipeline handles every message — inbound from Email Routing,
inbound from the mail bridge IMAP listener, and outbound REST
submissions. Both directions share the same input validation, address
normalisation, attachment limits, and audit semantics. There is no
parallel path that can drift.

For each message, the pipeline:

1. Resolves `mailbox_id` (from a recipient match or a principal scope).
2. Canonicalises MIME or the JSON `SendRequest` into the unified `Message`
   shape.
3. Writes small bodies inline to D1; writes large bodies and attachments
   to R2 under content-addressed keys.
4. Enqueues the message — inbound goes to webhook fan-out, outbound goes
   to the provider.
5. Appends a row to `audit_log`, hash-chained to the previous row.

## Storage

| Store      | Holds                                                                                                                                                                                                                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1**     | Source of truth: mailboxes, senders, receivers, principals, messages, webhook subs, audit log, bookkeeping. Single database (`polaris-email`).                                                                                                                                                                             |
| **R2**     | Content-addressed bodies and attachments + weekly D1 export under `backups/d1/`, reference-counted by `r2_refs`. Served over the public custom domain `r2.mail.plrs.im`. SHA-256 keys are the unguessability boundary — there is no signed URL layer. See the [threat model](/security/threat-model) before changing this. |
| **KV**     | Hot path: HMAC replay nonces, idempotency keys (24h TTL), rate limits, `key_id → secret` cache, **credential revocations**. Revocations propagate to all Workers within ≤60 s (KV write + 60 s per-Worker cache).                                                                                                          |
| **Queues** | Outbound, inbound, fan-out — each with its own DLQ.                                                                                                                                                                                                                                                                        |

Identical attachments forwarded to multiple mailboxes share one R2 object
via reference counting. Soft-deletes decrement the ref count; the nightly
retention janitor inside `api` frees the underlying bytes only when refs
reach zero.

## Webhook fan-out

The webhook queue consumer inside `api` is the **only** place outgoing
webhooks are signed. The envelope is **v2** — the full `Message` is
inlined in the event, so receivers do not need a follow-up `GET`. The
signature uses the `polaris-webhook` HMAC domain tag.

See the [unified Message model](/developers/messages/unified-model) for
the envelope shape and the [HMAC concept](/developers/authentication/concept)
for what the signature covers.

## Audit chain integrity

Every state mutation appends a row to `audit_log` with `row_hash =
SHA-256(prev_hash || canonical(row))` linking to the previous row. Any
out-of-band rewrite of an older row breaks `row_hash` for every later
row. The `audit-verify` cron in `api` walks the chain end-to-end nightly
and records the outcome in `cron_runs(job_name='audit-verify')`. The
panel "Audit chain" diagnostics card surfaces the head + freshness.

This defends against accidental / sloppy direct-DB writes. It does **not**
defend against an adversary who fully owns the Cloudflare account (they
can recompute the chain end-to-end). The recovery surface for that
threat is **D1 Time-Travel** (~30 days of point-in-time restore) plus the
weekly D1 export to R2 (`backups/d1/`, 12-week R2 lifecycle retention) —
see [D1 backup](/operators/day-2/d1-backup) and
[D1 recovery](/operators/day-2/d1-recovery). The accepted trade-off is
documented in [`SECURITY.md`](/security/threat-model).

## Authentication

| Surface     | Mechanism                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API         | HMAC-signed requests with the `polaris-api` domain tag. `key_id` + secret per principal. Revocation via `KV_REVOCATIONS`, ≤60 s propagation. See [HMAC concept](/developers/authentication/concept).                     |
| Panel       | better-auth with OIDC (default IdP is Cloudflare Access). Sessions in D1. Destructive actions gated client-side via type-the-resource-name confirmation; every mutation lands in the hash-chained `audit_log`.           |
| Mail bridge | Per-bridge HMAC key seeded at registration; mailbox credentials (bcrypt hashes) mirrored locally for SMTPS / IMAP auth. The global bridge HMAC key was retired — a single leaked key no longer compromises every bridge. |

Revocation is KV-backed. The previous Durable Object revocation channel
was retired; do not reintroduce one.

## Mail bridge deployment modes

The on-prem bridge ships in **two equally-supported deployment modes**.
Neither is the default — the wizard never pre-selects one.

- **Tailnet-fronted** — Tailscale sidecar, MagicDNS hostname, TLS via
  `tsnet.ListenTLS` (Lego ACME-DNS-01 fallback).
- **Local / host-network** — operator owns firewall and TLS termination
  (PEM mounted at `/etc/polaris-bridge/tls/`, or Lego).

Both modes use the same image, the same `bridge.toml`, the same env-var
overrides. Only the network attachment and the TLS source differ. See
[Mail bridge](/operators/concepts/mail-bridge) for the full operator
view.

## What's intentionally not here

- **Multi-folder IMAP.** INBOX only on the bridge.
- **Full-text search of message bodies.** FTS5 is deliberately excluded.
- **A forensic key-escrow Worker.** The architecture is
  zero-payload-by-default; consumer-side outbound logging is the expected
  pattern for subpoena response.
- **A CDN or signed-URL layer in front of R2.** SHA-256 keys are the
  unguessability boundary. Read the [threat model](/security/threat-model)
  before reconsidering this.

## See also

- [Cost model](/operators/concepts/cost-model) — bill projections at
  small / medium / large traffic tiers.
- [Mail bridge](/operators/concepts/mail-bridge) — on-prem SMTPS + IMAP
  binary, deployment modes, IMAP IDLE push flow.
- [Threat model](/security/threat-model) — trust boundaries, in-scope
  adversaries, mitigations.
- [Unified Message model](/developers/messages/unified-model) — the
  shape every message takes through the pipeline.

<!-- Verified against: docs/architecture.md, CLAUDE.md, SECURITY.md, packages/pipeline/src/, services/api/src/queue/fanout.ts, packages/hmac/src/index.ts @ eeee222cdf8359f8f2bf1013a103abdb3c705f06 -->
