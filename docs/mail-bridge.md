# polaris-mail-bridge — operator guide

A single Go binary (`apps/mail-bridge/`) that consolidates the three on-prem
mail protocols polaris supports: SMTPS submission, IMAP4rev2 retrieval, and
JMAP. Replaces the old `apps/submission-daemon`; the SMTPS code path is the
same, joined by IMAP and JMAP listeners and a bridge-local SQLite mirror.

## Architecture

```
              ┌──────────────────────────────────────────────┐
              │                                              │
              │   apps/mail-bridge (single Go binary)        │
              │                                              │
   :465 ─────►│   internal/smtp/        (RFC 6409 / 8314)    │
   :993 ─────►│   internal/imap/        (RFC 9051 subset)    │
   :443 ─────►│   internal/jmap/        (RFC 8620/8621/8887) │
              │                                              │
              │   internal/push/        (WebSocket + SSE)    │
              │   internal/webhook/     (receives message.   │
              │                          received from API)  │
              │   internal/store/       (SQLite mirror)      │
              │   internal/auth/        (mailbox_credentials)│
              │                                              │
              └─────────────┬────────────────────────────────┘
                            │
                            ▼   (HMAC v1 over service binding or HTTPS)
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
{ "action": "accept", "src": ["tag:client"],       "dst": ["tag:polaris-mail"], "ports": ["465", "993", "443"] }
{ "action": "accept", "src": ["tag:polaris-mail"], "dst": ["tag:api-backend"],  "ports": ["443"] }
```

### Mode 2 — Local / host-network

- Bridge binds 465 / 993 / 443 directly to the host network.
- Operator owns firewall, reverse proxy (optional), TLS termination.
- TLS sources, in priority order: operator-mounted PEM at
  `/etc/polaris-bridge/tls/`, then Lego ACME-DNS-01 if the `lego` profile
  is enabled.
- Compose: `apps/mail-bridge/docker-compose.local.yml`.
- Use when: the bridge host is itself the public entry point, or it sits
  behind a load balancer / reverse proxy that you manage.

Reverse-proxy hint (Caddy for example):

```caddy
mail.example.com:443 {
  reverse_proxy /jmap/* 127.0.0.1:443
}
# Pass IMAP/SMTPS through as raw TCP via layer-4 LB (haproxy / nginx-stream).
```

## Mail-client setup

| Client       | SMTPS | IMAP | JMAP                           |
| ------------ | ----- | ---- | ------------------------------ |
| Thunderbird  | ✔     | ✔    | ✔ (v102+)                      |
| Apple Mail   | ✔     | ✔    | ✘ (no JMAP support as of 2026) |
| `mutt`       | ✔     | ✔    | n/a                            |
| fastmail-cli | n/a   | n/a  | ✔                              |
| aerc         | n/a   | ✔    | ✔                              |

Configure each client against the bridge's hostname (Mode 1: MagicDNS;
Mode 2: whatever DNS you publish for the host). Username + password are
issued via `POST /v1/admin/mailboxes/:id/credentials`.

## JMAP push flow

```
1. Bridge boots → registers a webhook subscription with polaris pointing
   at its own hostname's /internal/webhook/message-received endpoint.
2. Polaris receives inbound message → fanout fires the webhook.
3. Bridge internal/webhook/handler verifies HMAC v2 signature, bumps the
   mailbox's local change_id, calls internal/push/manager.Broadcast.
4. Push manager iterates jmap_push_subscriptions:
     - websocket: send StateChange frame on the open WS
     - eventsource: write StateChange to the SSE stream
5. Client receives StateChange, calls Email/changes with its current
   state token, bridge returns the delta.
```

If the bridge is offline when polaris fires, the event lands in webhook DLQ;
once the bridge is back, the operator replays from the DLQ browser.

## Roadmap — what this iteration leaves as TODO

The first commit of `apps/mail-bridge/` lands the structural foundation:
directory rename, schema (`0002_bridge.sql`), the two compose files,
`bridge.toml`, and this guide. The IMAP/JMAP/WebSocket protocol handlers
ship in follow-up slices:

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
- **L.4 — JMAP server**: Mailbox/{get,query,changes}, Email/{get,query,
  changes,set,queryChanges,parse}, Thread/{get,changes}, Identity/{get,
  query,set,changes}, EmailSubmission/{set,get,query,changes,queryChanges},
  PushSubscription/{set,get}. WebSocket (RFC 8887) primary, SSE fallback.
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
- IMAP body-text SEARCH and JMAP `SearchSnippet/*` (no FTS5).
- JMAP `VacationResponse/*`, `Quota/*`, `Email/import`, `Email/copy`.
- JMAP Contacts (CardDAV territory), Calendars (CalDAV territory), Sieve.
- Drafts folder and `\Draft` flag.

## Troubleshooting

Symptoms → check:

- IMAP IDLE never fires push → confirm the bridge auto-registered its
  webhook subscription (look in polaris audit for
  `webhook_sub.create`). Re-register manually if needed.
- JMAP `Email/changes` returns stale state → state token includes the
  bridge-local `change_id`; if the local mirror is behind, the baseline
  refresh interval (`[mirror].baseline_refresh`) controls catch-up.
- TLS errors in tailnet mode → check `tailscale cert` output on the
  sidecar; MagicDNS certs auto-renew but require `tailscale up
--hostname=...` to have run successfully first.
- TLS errors in local mode → verify `BRIDGE_TLS_CERT_PATH` and
  `BRIDGE_TLS_KEY_PATH` are readable inside the container and that
  fsnotify can watch the directory (some bind-mount strategies on
  macOS do not propagate inotify events).
