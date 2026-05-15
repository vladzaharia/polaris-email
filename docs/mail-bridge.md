# polaris-mail-bridge — operator guide

A single Go binary (`apps/mail-bridge/`) that consolidates the two on-prem
mail protocols polaris supports: **SMTPS submission and IMAP4rev2
retrieval**. (No JMAP — the hand-rolled JMAP listener was deleted in
phase C1.) Replaces the old `apps/submission-bridge`; the SMTPS code path
is the same, joined by an IMAP listener and a bridge-local SQLite mirror.

The IMAP listener will be migrated to
[`github.com/emersion/go-imap/v2`](https://github.com/emersion/go-imap)
(sibling of `go-smtp` and `go-sasl` already in use). **In progress** — the
current commit still ships the hand-rolled handler; the migration lands in
phase O2. The on-the-wire protocol the operator sees does not change.

## Architecture

```
              ┌──────────────────────────────────────────────┐
              │                                              │
              │   apps/mail-bridge (single Go binary)        │
              │                                              │
   :465 ─────►│   internal/smtp/        (RFC 6409 / 8314)    │
   :993 ─────►│   internal/imap/        (RFC 9051 subset)    │
              │                                              │
              │   internal/push/        (IMAP IDLE fan-out)  │
              │   internal/webhook/     (receives message.   │
              │                          received from API)  │
              │   internal/store/       (SQLite mirror)      │
              │   internal/auth/        (mailbox_credentials)│
              │                                              │
              └─────────────┬────────────────────────────────┘
                            │
                            ▼   (HMAC over service binding or HTTPS)
                  polaris-email REST API
                  (services/api on Cloudflare Workers)
```

## Two deployment modes — equally supported

Pick whichever matches your network topology. Neither mode is "the default."

### Mode 1 — Tailnet-fronted

- All listeners run inside a `tailscale/tailscale:stable` sidecar's network
  namespace.
- Hostname pattern: `polaris-mail-${REGION}.<tailnet>.ts.net` (MagicDNS).
- TLS: Tailscale-issued certs via `tsnet.ListenTLS` (preferred), Lego
  ACME-DNS-01 as fallback.
- Only tailnet members reach the bridge; the host exposes no public ports.
- Compose: `apps/mail-bridge/docker-compose.tailscale.yml`.
- Use when: every mail client is on your tailnet (operator laptops, regional
  hubs, CI workers, etc.).

Tailnet ACL example:

```hcl
{ "action": "accept", "src": ["tag:client"],       "dst": ["tag:polaris-mail"], "ports": ["465", "993"] }
{ "action": "accept", "src": ["tag:polaris-mail"], "dst": ["tag:api-backend"],  "ports": ["443"] }
```

### Mode 2 — Local / host-network

- Bridge binds 465 / 993 directly to the host network.
- Operator owns firewall, reverse proxy (optional), TLS termination.
- TLS sources, in priority order: operator-mounted PEM at
  `/etc/polaris-bridge/tls/`, then Lego ACME-DNS-01 if the `lego` profile
  is enabled.
- Compose: `apps/mail-bridge/docker-compose.local.yml`.
- Use when: the bridge host is itself the public entry point, or it sits
  behind a load balancer / reverse proxy that you manage.

Reverse-proxy hint (haproxy / nginx-stream): pass SMTPS (`:465`) and IMAPS
(`:993`) through as raw TCP via a layer-4 LB.

## Mail-client setup

| Client      | SMTPS | IMAP |
| ----------- | ----- | ---- |
| Thunderbird | ✔     | ✔    |
| Apple Mail  | ✔     | ✔    |
| `mutt`      | ✔     | ✔    |
| aerc        | n/a   | ✔    |

Configure each client against the bridge's hostname (Mode 1: MagicDNS;
Mode 2: whatever DNS you publish for the host). Username + password are
issued via `POST /v1/admin/mailboxes/:id/credentials`.

## Authentication

Both SMTPS and IMAP use the same auth surface: per-mailbox
`mailbox_credentials` rows. The control plane stores **bcrypt password
hashes only** (the plaintext is revealed exactly once at creation or
rotation, per the read-once secrets policy). The bridge mirrors the
hashed credentials locally via the SQLite mirror; clients authenticate
with PLAIN/LOGIN over implicit TLS and the bridge compares with bcrypt.

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
   mirror for the affected mailbox, then calls internal/push/manager.Broadcast.
4. Push manager iterates IMAP IDLE sinks for the mailbox and writes
   `* <n> EXISTS` untagged responses.
5. Client receives the EXISTS line and issues a FETCH for the new UID
   range; the bridge serves it from the just-refreshed mirror.
```

If the bridge is offline when polaris fires, the event lands in webhook DLQ;
once the bridge is back, the operator replays from the DLQ browser.

## IMAP capability advertisement

The bridge does not hand-enumerate IMAP capability strings — the
`go-imap/v2` server library publishes whatever capabilities the
backend actually implements. Trust what the library advertises; do not
parse this doc as the authoritative capability list. The wire
behaviour and supported `CAPABILITY` extensions are determined by the
library version in `apps/mail-bridge/go.mod`.

## Roadmap — what this iteration leaves as TODO

- **L.5 — bridge-local mirror reactive refresh**: react to incoming
  webhooks to invalidate / refresh affected mailbox state in
  `mirror.db`. Today the mirror does a 30s baseline pull.
- **L.6 — multi-region notes**: the bridge runs single-region against a
  single-region D1; multi-region R2 is enabled at the bucket level so
  body FETCH hits the nearest replica. Documented operational notes for
  region-pair latency (target: < 10ms intra-region for FETCH metadata,
  < 100ms cross-region for body bytes).
- **O2 — IMAP migration to `emersion/go-imap` v2**: replace the
  hand-rolled handler with the upstream library (LOGIN, AUTHENTICATE
  PLAIN, CAPABILITY, LIST, SELECT/EXAMINE, FETCH, STORE, EXPUNGE,
  IDLE, CONDSTORE, header/flag SEARCH). The bridge-side `internal/store/`
  and webhook-driven push fan-out are preserved as-is.

Out of polaris-mail-bridge product scope (deliberate cuts, not deferrals):

- Multi-folder mail organization (INBOX only).
- IMAP `MOVE` / `COPY` / `APPEND` / `LSUB` / `QRESYNC`.
- IMAP body-text SEARCH (no FTS5).
- Drafts folder and `\Draft` flag.

## Troubleshooting

Symptoms → check:

- IMAP IDLE never fires push → confirm the bridge auto-registered its
  webhook subscription (look in polaris audit for
  `webhook_sub.create`). Re-register manually if needed.
- TLS errors in tailnet mode → check `tailscale cert` output on the
  sidecar; MagicDNS certs auto-renew but require `tailscale up
--hostname=...` to have run successfully first.
- TLS errors in local mode → verify `BRIDGE_TLS_CERT_PATH` and
  `BRIDGE_TLS_KEY_PATH` are readable inside the container and that
  fsnotify can watch the directory (some bind-mount strategies on
  macOS do not propagate inotify events).
