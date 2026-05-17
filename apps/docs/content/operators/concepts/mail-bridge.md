---
title: Mail bridge
description: The on-prem Go binary that fronts SMTPS (:465) and IMAP4rev2 (:993) for polaris-email mailboxes — architecture, deployment modes, IMAP IDLE push flow, and troubleshooting.
sidebar_label: Mail bridge
sidebar_position: 3
---

# polaris-mail-bridge

A single Go binary (`apps/mail-bridge/`) that consolidates the two
on-prem mail protocols polaris supports: **SMTPS submission and
IMAP4rev2 retrieval**. No JMAP — the hand-rolled JMAP listener was
deleted in pre-launch hardening, along with the
`mailbox_credentials.bearer_token` column.

The IMAP listener runs on
[`github.com/emersion/go-imap/v2`](https://github.com/emersion/go-imap)
(sibling of `go-smtp` and `go-sasl` already in use). Pre-launch
hardening additionally fixed STORE / EXPUNGE / `BODY[]` correctness
paths in this listener.

## Architecture

```
              ┌──────────────────────────────────────────────┐
              │                                              │
              │   apps/mail-bridge (single Go binary)        │
              │                                              │
   :465 ─────►│   internal/smtp/        (RFC 6409 / 8314)    │
   :993 ─────►│   internal/imap/        (RFC 9051 subset)    │
   :8080 ────►│   internal/webhook/     (receives            │
              │                          message.received    │
              │                          from services/api)  │
              │                                              │
              │   internal/push/        (IMAP IDLE fan-out)  │
              │   internal/credstore/   (mailbox credential  │
              │                          mirror, SQLite)     │
              │   internal/store/       (message-state       │
              │                          mirror, SQLite)     │
              │                                              │
              └─────────────┬────────────────────────────────┘
                            │
                            ▼   (HMAC over service binding or HTTPS)
                  polaris-email REST API
                  (services/api on Cloudflare Workers)
```

## Two deployment modes — equally supported

Pick whichever matches your network topology. **Neither mode is the
default.** Both compose files are first-class. Both modes use the same
image, same `bridge.toml`, same env-var overrides — only the network
mode and TLS source differ.

### Mode 1 — Tailnet-fronted

- All listeners run inside a `tailscale/tailscale:stable` sidecar's
  network namespace.
- Hostname pattern: `polaris-mail-${REGION}.<tailnet>.ts.net` (MagicDNS).
- TLS: Tailscale-issued certs via `tsnet.ListenTLS` (preferred), Lego
  ACME-DNS-01 as fallback. Cert paths follow the Lego output layout:
  `/etc/polaris-bridge/tls/certificates/<fqdn>.{crt,key}`. Rotation
  re-runs the `lego` profile (`docker compose --profile lego up`).
- Only tailnet members reach the bridge; the host exposes no public
  ports.
- Compose: `apps/mail-bridge/docker-compose.tailscale.yml`.
- Use when: every mail client is on your tailnet (operator laptops,
  regional hubs, CI workers).

Tailnet ACL example:

```hcl
{ "action": "accept", "src": ["tag:client"],       "dst": ["tag:polaris-mail"], "ports": ["465", "993"] }
{ "action": "accept", "src": ["tag:polaris-mail"], "dst": ["tag:api-backend"],  "ports": ["443"] }
```

### Mode 2 — Local / host-network

- Bridge binds **465 (SMTPS) + 993 (IMAPS) + 8080 (webhook receiver)**
  directly to the host network. Port 8080 is the inbound webhook
  target polaris fires on `message.received`; either expose it
  directly or put a reverse proxy in front of it and set
  `BRIDGE_PUBLIC_URL` to the proxy's HTTPS URL.
- Operator owns firewall, reverse proxy (optional), TLS termination.
- TLS sources, in priority order: operator-mounted PEM at
  `/etc/polaris-bridge/tls/`, then Lego ACME-DNS-01 if the `lego`
  profile is enabled.
- Compose: `apps/mail-bridge/docker-compose.local.yml`.
- Use when: the bridge host is itself the public entry point, or it
  sits behind a load balancer / reverse proxy that you manage.

Reverse-proxy hint (haproxy / nginx-stream): pass SMTPS (`:465`) and
IMAPS (`:993`) through as raw TCP via a layer-4 LB. The webhook
receiver (`:8080`) is plain HTTP — terminate TLS at your reverse proxy
when you want public-internet TLS for it.

## Mail-client setup

| Client      | SMTPS | IMAP |
| ----------- | ----- | ---- |
| Thunderbird | yes   | yes  |
| Apple Mail  | yes   | yes  |
| `mutt`      | yes   | yes  |
| aerc        | n/a   | yes  |

Configure each client against the bridge's hostname (Mode 1: MagicDNS;
Mode 2: whatever DNS you publish for the host). Username + password
are issued via `POST /v1/admin/mailboxes/:id/credentials`.

## Authentication

Both SMTPS and IMAP use the same auth surface: per-mailbox
`mailbox_credentials` rows. The control plane stores **bcrypt password
hashes only** (the plaintext is revealed exactly once at creation or
rotation, per the read-once secrets policy — see the
[threat model](/security/threat-model)). The bridge mirrors the hashed
credentials locally via `internal/credstore/`; clients authenticate
with PLAIN / LOGIN over implicit TLS and the bridge compares with
bcrypt.

There are **no bearer tokens** on this bridge — the JMAP-era
`mailbox_credentials.bearer_token` column was dropped along with JMAP.
Bridge-to-control-plane traffic uses HMAC over the service binding /
HTTPS path; client-to-bridge traffic uses bcrypt passwords only.

## IMAP IDLE push flow

```
1. Bridge boots → registers a webhook subscription with polaris pointing
   at its own hostname's /internal/webhook/message-received endpoint.
2. Polaris receives inbound message → fanout fires the webhook.
3. Bridge internal/webhook/handler verifies the signature, refreshes the
   mirror for the affected mailbox via Refresher.RefreshMailbox, then
   calls internal/push/manager.Broadcast.
4. Push manager iterates IMAP IDLE sinks for the mailbox and writes
   `* <n> EXISTS` untagged responses.
5. Client receives the EXISTS line and issues a FETCH for the new UID
   range; the bridge serves it from the just-refreshed mirror.
```

If the bridge is offline when polaris fires, the event lands in webhook
DLQ; once the bridge is back, the operator replays from the DLQ browser.

## IMAP capability advertisement

The bridge does not hand-enumerate IMAP capability strings — the
`go-imap/v2` server library publishes whatever capabilities the
backend actually implements. Trust what the library advertises; do not
parse this doc as the authoritative capability list. The wire
behaviour and supported `CAPABILITY` extensions are determined by the
library version pinned in `apps/mail-bridge/go.mod`.

## Hardening

Implemented:

- **Reactive mirror refresh** — incoming webhooks call
  `Refresher.RefreshMailbox` BEFORE broadcasting `* n EXISTS`, so
  IDLE clients that race the FETCH find the new row already present.
- **Per-IP connection cap** — 10 concurrent SMTPS connections per
  remote IP (`MaxConnsPerIP` in `internal/smtp/backend.go`).
- **Auth lockout** — 5 failures inside 60 s → 5 min cooldown,
  per-credential. Further failed attempts during the block window
  re-engage the lock.
- **TLS 1.3 minimum** — `tls.VersionTLS13` baked into the bridge's TLS
  config (`internal/tls/tls.go`).

Forward-looking, not deferrals:

- **Multi-region operational notes** — the bridge runs single-region
  against a single-region D1; multi-region R2 is enabled at the bucket
  level so body FETCH hits the nearest replica. Target: &lt;10 ms
  intra-region for FETCH metadata, &lt;100 ms cross-region for body bytes.

Out of polaris-mail-bridge product scope (deliberate cuts, not
deferrals):

- Multi-folder mail organization (INBOX only).
- IMAP `MOVE` / `COPY` / `APPEND` / `LSUB` / `QRESYNC`.
- IMAP body-text SEARCH (no FTS5).
- Drafts folder and `\Draft` flag.
- Full `BODYSTRUCTURE` MIME-tree walk for multipart messages (the stub
  returns a single-part text/plain envelope which is good enough for
  the IMAP clients the bridge targets).

## Troubleshooting

Symptom → check:

- **IMAP IDLE never fires a push** → confirm the bridge auto-registered
  its webhook subscription (look in polaris audit for
  `webhook_sub.create`). Re-register manually if needed.
- **TLS errors in tailnet mode** → check `tailscale cert` output on the
  sidecar; MagicDNS certs auto-renew but require
  `tailscale up --hostname=...` to have run successfully first.
- **TLS errors in local mode** → verify `BRIDGE_TLS_CERT_PATH` and
  `BRIDGE_TLS_KEY_PATH` are readable inside the container. Cert reloads
  use a 30 s per-accept cadence (no fsnotify dependency); rotated certs
  pick up within 30 s of an ACME renewal.

See [Operators](/operators) for the broader runbook library covering
domain onboarding, credential rotation, and DLQ replay.

<!-- Verified against: apps/mail-bridge/internal/{smtp,imap,webhook,credstore,tls}/, apps/mail-bridge/bridge.toml, apps/mail-bridge/docker-compose.{local,tailscale}.yml, apps/mail-bridge/go.mod, docs/mail-bridge.md @ 60cc6d59541b3279a65c755222fd9290ce76fc5e -->
