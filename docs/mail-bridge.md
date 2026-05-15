# polaris-mail-bridge — operator guide

A single Go binary (`apps/mail-bridge/`) that consolidates the two on-prem
mail protocols polaris supports: SMTPS submission and IMAP4rev2 retrieval.
Replaces the old `apps/submission-bridge`; the SMTPS code path is the same,
joined by an IMAP listener and a bridge-local SQLite mirror.

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

## Roadmap — what this iteration leaves as TODO

The first commit of `apps/mail-bridge/` lands the structural foundation:
directory rename, schema (`0002_bridge.sql`), the two compose files,
`bridge.toml`, and this guide. The IMAP protocol handler ships in
follow-up slices:

- **L.2 — backend endpoints**: PATCH/DELETE/expunge, bulk get, changes,
  bulk metadata, mailbox credentials CRUD. Auto-mark-read when called
  with `imap_bridge:read` scope. Reference-counted R2 deletion honoring
  `expunged_at`.
- **L.3 — IMAP server**: LOGIN, CAPABILITY, LIST, SELECT/EXAMINE, FETCH
  (UID + FLAGS + ENVELOPE + RFC822.SIZE + BODYSTRUCTURE), STORE
  (`\Seen`/`\Flagged`/`\Deleted` and custom keywords), EXPUNGE, IDLE with
  webhook-driven push, CONDSTORE (MODSEQ = `mailbox_messages_state.change_id`),
  header/flag SEARCH (FROM, TO, SUBJECT, FLAGGED, SEEN, UNSEEN, SINCE,
  BEFORE, ON, LARGER, SMALLER, HEADER).
- **L.5 — bridge-local mirror reactive refresh**: react to incoming
  webhooks to invalidate / refresh affected mailbox state in
  `mirror.db`. Today the mirror does a 30s baseline pull.
- **L.6 — multi-region notes**: the bridge runs single-region against a
  single-region D1; multi-region R2 is enabled at the bucket level so
  body FETCH hits the nearest replica. Documented operational notes for
  region-pair latency (target: < 10ms intra-region for FETCH metadata,
  < 100ms cross-region for body bytes).

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
