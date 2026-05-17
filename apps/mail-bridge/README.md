# polaris-mail-bridge

On-prem unified mail bridge for Polaris. One Go binary, two protocols:

- **SMTPS** on `:465` — outbound submission (formerly `apps/submission-bridge`)
- **IMAP4rev2** on `:993` — INBOX retrieval, IDLE, CONDSTORE (RFC 9051 subset)

Both listeners share a single auth lookup against `mailbox_credentials`
in polaris D1, a 5k-entry LRU cache, and a bridge-local SQLite mirror of
`mailbox_messages_state` for low-latency reads.

See <https://docs.mail.plrs.im/operators/concepts/mail-bridge> for the full
deployment and operator guide (and `apps/docs/docs/operators/concepts/mail-bridge.md`
for the source).

## Two deployment modes — equally supported

The bridge ships with **two first-class compose files**. Neither is the default;
pick whichever matches your network topology.

### Mode 1 — Tailnet-fronted (`docker-compose.tailscale.yml`)

A Tailscale sidecar fronts both listeners on the same MagicDNS hostname
(`polaris-mail-${REGION}.<tailnet>.ts.net`). TLS via Tailscale-issued certs
through `tsnet.ListenTLS`, with Lego as ACME-DNS-01 fallback. Only tailnet
members reach the bridge; the host exposes no public ports.

```bash
TS_AUTHKEY=tskey-... \
REGION=us-east \
docker compose -f docker-compose.tailscale.yml up -d
```

Tailnet ACL example (single tag `tag:polaris-mail`):

```hcl
{ "action": "accept", "src": ["tag:client"], "dst": ["tag:polaris-mail"],
  "ports": ["465", "993"] }
{ "action": "accept", "src": ["tag:polaris-mail"], "dst": ["tag:api-backend"],
  "ports": ["443"] }
```

### Mode 2 — Local / host-network (`docker-compose.local.yml`)

The bridge binds 465 / 993 directly to the host network. The operator
owns the firewall, optional reverse proxy, and TLS termination (operator-
mounted PEM files at `/etc/polaris-bridge/tls/`, or Lego ACME-DNS-01).
Suitable when the host is already the public entry point or sits behind a
load balancer you control.

```bash
BRIDGE_TLS_DIR=./tls \
BRIDGE_FQDN=mail.example.com \
docker compose -f docker-compose.local.yml up -d
```

Both modes use the same `bridge` image, the same `bridge.toml` schema, and
the same env-var overrides. Only the network mode and TLS source differ.

## Build

```bash
make build      # native binary at bin/polaris-bridge
make test       # unit tests
make docker     # builds polaris-mail-bridge:dev (CGO disabled, modernc.org/sqlite)
```

## Mail-client setup

- **Thunderbird** — IMAP (Mode 1 + 2) plus SMTPS submission.
- **Apple Mail** — IMAP retrieval plus SMTPS submission (same
  `mailbox_credentials` row when both use `auth_type='password'` under
  different protocols, distinct rows otherwise).
- **mutt / aerc** — IMAP-capable.

See <https://docs.mail.plrs.im/operators/concepts/mail-bridge> for protocol-specific quirks.

## Configuration

`bridge.toml` controls all listener and TLS settings. Every key has a
`BRIDGE_<SECTION>_<KEY>` env-var override, useful for compose-layer config.
