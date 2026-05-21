---
title: Bridge credential sync
description: Detection and recovery for mail-bridge credential drift — confirming drift, forcing a resync, recovering from HMAC key drift, the full-resync escape hatch, and auth lockout side effects.
sidebar_label: Bridge credential sync
sidebar_position: 3
---

# Bridge credential sync

The mail-bridge maintains a local SQLite mirror of mailbox submission
credentials. The mirror is refreshed by a poller against
`GET /v1/bridge/credentials` on a configurable interval (default 30s).
This runbook covers detection and recovery for credential drift.

## Detection signals

- SMTP AUTH starts failing with 535 for a credential the operator
  just issued.
- The bridge logs `polaris-bridge: credstore initial sync did not
complete within 30s` on startup.
- The panel shows a credential as Active, but the bridge rejects it
  for the next ~60s.

## Confirm drift

On the bridge host:

```sh
docker compose exec polaris-bridge sqlite3 /var/lib/polaris-bridge/credstore.db \
  "SELECT username, revoked_at, mirror_version FROM credentials WHERE username = 'noreply@example.com';"
```

Compare `mirror_version` and `revoked_at` against the panel:
`/admin/credentials/<id>`. If the bridge's mirror is stale or missing the
row, the poller is the suspect.

## Force a resync

The poller fires once per `PollInterval`; you can shorten the next cycle
by restarting the bridge:

```sh
docker compose restart polaris-bridge
```

Restart is safe: in-flight SMTPS sessions get a fresh AUTH on the next
command, IMAP IDLE sessions reconnect on TCP close.

## Recover from HMAC key drift

If the bridge's HMAC key was rotated on polaris but the bridge's
`registration.json` still has the old secret, every poll request returns
401 and the mirror stops refreshing. Symptoms:

- Bridge logs `polaris-bridge: poll: HTTP 401`.
- Mirror `mirror_version` does not advance.

Recovery:

1. On the control plane, re-issue the bridge HMAC key:
   `polaris-mail bridge rotate <bridge_id>`. The command prints the
   new secret once — capture it.
2. Update the bridge's mount: write the new `registration.json` with the
   matching `hmac_key_secret`.
3. `docker compose restart polaris-bridge`.
4. Confirm: `wrangler tail polaris-mail-api --search bridge-poll` shows
   200s within the next poll interval.

## Force a full resync (operator escape hatch)

Wipe the mirror and let the poller rebuild from scratch:

```sh
docker compose stop polaris-bridge
docker compose exec polaris-bridge rm -f /var/lib/polaris-bridge/credstore.db
docker compose start polaris-bridge
```

The bridge will block SMTPS AUTH (454) until the initial sync completes
(up to 30s). Run this only if you suspect SQLite corruption — normal
drift heals via the next successful poll.

## Auth lockout side effects

In-process auth-failure lockouts (5 fails / 60s → 5 min block) are
per-bridge-process. A restart clears them — useful if a legitimate
client got locked out during a misconfiguration window.

<!-- Verified against: docs/runbooks/bridge-credential-sync.md @ c3c1b5048dd5bfe92facdce24982141a07446042 -->
