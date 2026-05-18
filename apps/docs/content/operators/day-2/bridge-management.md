---
title: Bridge management
description: Register, list, rotate, and deregister on-prem mail bridges. Each bridge has its own HMAC key and Cloudflare Access service token. Two deployment modes (tailnet-fronted and host-network) are equally supported.
sidebar_label: Bridge management
sidebar_position: 7
---

# Bridge management

The polaris-email mail bridge (Go binary `polaris-bridge`) accepts
SMTPS submission on `:465`, serves IMAP4rev2 on `:993`, and forwards
both to the control plane. Each bridge has its own identity, its own
HMAC key in Workers Secrets, and its own Cloudflare Access service
token. The audit log records `bridge_id` on every authenticated
session.

See [the mail-bridge concept page](/operators/concepts/mail-bridge)
for the system view; this page is the day-2 operator workflow.

## Two equally-supported deployment modes

The bridge runs in one of two modes. **Neither is canonical.** Pick
based on operational fit:

- **Tailnet-fronted** —
  [`apps/mail-bridge/docker-compose.tailscale.yml`](https://github.com/vladzaharia/polaris-email/blob/main/apps/mail-bridge/docker-compose.tailscale.yml).
  Tailscale sidecar, MagicDNS hostname, TLS via `tsnet.ListenTLS`
  (Lego ACME-DNS-01 fallback).
- **Host-network (local)** —
  [`apps/mail-bridge/docker-compose.local.yml`](https://github.com/vladzaharia/polaris-email/blob/main/apps/mail-bridge/docker-compose.local.yml).
  Operator owns firewall + TLS termination (PEM mounted at
  `/etc/polaris-bridge/tls/`, or Lego).

Both modes use the same image, the same `bridge.toml`, and the same
env-var overrides. Only the network mode and TLS source differ.

## Live `up` TUI

`polaris-email setup bridge up` brings the bridge online with a live
Bubble Tea TUI: the merged `docker compose logs -f` stream renders at
the top of the screen while a probe table at the bottom updates as
each post-up health check (SMTPS handshake, IMAP CAPABILITY, webhook
`/healthz`, control-plane `last_seen`) finishes. The program exits
cleanly when every required probe passes; a failing probe — or a 60s
timeout — surfaces as a non-zero exit and leaves the screen state
visible until you press `q` to dismiss.

Press `q`, `esc`, or `Ctrl-C` to dismiss the view. Arrow keys scroll
the log pane. The same keys also work mid-run if you decide to bail
before the probes finish.

In CI or non-interactive shells the TUI is bypassed automatically and
the original plain-stdout streaming is used so log capture / CI scrapes
keep working unchanged. Force the fallback explicitly with
`--non-interactive` or by exporting `POLARIS_NO_TUI=1`.

## Register a new bridge

```sh
polaris-email bridge register edge-eu1 --form compose \
    --write ./registration.json
```

This mints the bridge's HMAC key and its Cloudflare Access service
token (both returned exactly once) and prints a docker-compose snippet
ready to drop onto the bridge host. The `registration.json` file
contains every secret the bridge needs to start; deposit it at
`/etc/polaris-bridge/registration.json` (or wherever your compose file
mounts it) on the bridge host.

The bridge refuses to start without a valid `registration.json`.

### Choose the form

`--form compose` prints a docker-compose stanza for the
host-network deployment. Use `--form tailscale-compose` (when
implemented) for the tailnet-fronted form. Today both deployment
modes consume the same `registration.json` — only the compose file
around it differs.

## List, show, rotate

```sh
polaris-email bridge list
polaris-email bridge show edge-eu1
polaris-email bridge rotate edge-eu1
```

`bridge rotate` issues a new HMAC key and a new Cloudflare Access
service token, prints them once, and starts the rollover. The prior
key keeps working until you drop the new `registration.json` onto the
host and restart the bridge container; once the new key sees its
first authenticated request, the old one is revoked automatically.

## Deregister

```sh
polaris-email bridge deregister edge-eu1 --confirm-name edge-eu1
```

`bridge deregister` requires `--confirm-name <name>` matching the
bridge name exactly. There is no two-person rule on bridge
deregistration, so typos are intentionally expensive — fat-fingering
the name and accidentally tearing down a live bridge is the failure
mode this flag prevents.

The bridge row is tombstoned, not hard-deleted; the audit log retains
the full history.

## Per-bridge HMAC isolation

The global `BRIDGE_HMAC_KEY` was retired in pre-launch hardening so a
single leaked key no longer compromises every bridge. Each bridge now
has its own HMAC secret stored as a wrangler secret on `services/api`
keyed by `bridge_id`. The blast radius of a leaked key is now one
bridge — the credentials it mirrors, the mailboxes it serves.

The per-bridge key still grants cross-mailbox read inside the bridge:
a bridge can fetch credentials and message state for any mailbox it
serves. This is intentional v1 scope; see
[the threat model](/security/threat-model#bridge-cross-mailbox-read-v1-scope)
for the full property statement and the v1.1 narrowing plan.

## TLS termination

Both deployment modes terminate TLS on the bridge itself — Cloudflare
does not handle SMTPS / IMAPS termination for the bridge surface
(it's a TCP listener, not an HTTPS surface).

In **tailnet-fronted** mode: TLS is served by `tsnet.ListenTLS`. If
the Tailscale TLS path is unavailable, the bridge falls back to Lego
with the ACME-DNS-01 challenge (the bridge does not expose `:80`).

In **host-network** mode: the operator owns TLS. Mount a PEM bundle
at `/etc/polaris-bridge/tls/` (cert + key) and the bridge will pick
it up at start. The bridge supports TLS cert hot-reload — renewing
the PEM in place does not require a container restart.

The full procedure — three TLS source modes (mounted PEM, Lego
ACME-DNS-01, Tailscale-issued), hot-reload cadence, rotation steps, and
the two alerts to wire — lives at [Bridge TLS](/operators/day-2/bridge-tls).

## Audit trail

Every authenticated SMTPS submission and every authenticated IMAP
session records a row in `audit_log` with the `bridge_id`. The chained
hash (see
[the threat model](/security/threat-model#audit-chain-integrity)) means a
compromised bridge cannot rewrite its session history without breaking
the chain — the nightly `audit-verify` cron will surface the break.

## Related runbooks

- [Bridge credential sync](/operators/runbooks/bridge-credential-sync) —
  triage when the bridge's local SQLite mirror diverges from the
  control-plane `mailbox_credentials` rows.

<!-- Verified against: docs/operator.md @ c3c1b5048dd5bfe92facdce24982141a07446042 -->
