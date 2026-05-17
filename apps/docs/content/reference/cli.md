---
title: CLI vocabulary
description: The four state-change verbs the polaris-email CLI uses — revoke, deregister, disable, delete — and when each one applies.
sidebar_label: CLI vocabulary
sidebar_position: 3
---

# polaris-email CLI vocabulary

The `polaris-email` CLI (and the panel admin UI) use four distinct verbs
for state changes that look superficially similar. They are not
interchangeable — pick the one that matches the intent.

For the full verb-by-verb tour with command examples, see
[Operators → CLI tour](/operators/day-2/cli-tour).

## revoke

**Target**: a credential (API key, SMTPS password, IMAP password, bridge
HMAC key).

**Effect**: the signing material is invalidated immediately. The
credential row remains in the database (for audit) but cannot
authenticate any future request. Revocation is recorded in
`KV_REVOCATIONS` and propagates to all Workers within ≤60 s (KV write +
60 s per-Worker cache).

**Reversible**: no. To restore access, rotate the credential — which
mints a new secret and shows it once.

```sh
polaris-email cred revoke <id>
```

Bridge HMAC keys do not have a `revoke` verb today — use `bridge rotate`
(planned rollover) or `bridge deregister` (terminal).

## deregister

**Target**: a bridge.

**Effect**: the bridge is disabled (cannot authenticate to the control
plane) and its mailbox-credential mirror is marked stale. The row is
soft-removed (`deregistered_at` set); credentials owned by other
bridges are unaffected.

**Reversible**: re-register with the same `bridge_id` to undo within a
short window; after the tombstone GC runs the id is permanently
retired.

```sh
polaris-email bridge deregister <name> --confirm-name <name>
```

`--confirm-name <name>` must match the bridge's name exactly. There is
no two-person rule; the type-the-name guard is what stops fat-finger
teardowns.

## disable

**Target**: a domain, a routing rule.

**Effect**: soft state change. The row stays; a `disabled_at` (or
equivalent) timestamp is set. Inbound / outbound traffic to or from the
target is rejected with a clear error code while it is disabled.

**Reversible**: yes — the matching `enable` flips the flag back and the
same row resumes serving traffic.

```sh
polaris-email domain disable <name>
polaris-email route disable <id>
polaris-email route enable <id>
```

Mailbox-, webhook-subscription-, and principal-level disable flows run
through the admin REST surface today — CLI parity is intentional
follow-up.

## delete

**Target**: a domain, a routing rule.

**Effect**: hard removal. The row is tombstoned (`deleted_at` set) and
FK constraints to dependent rows are checked first — you cannot delete a
domain that still owns messages, mailboxes, or webhook subs without an
explicit cascade flag. The retention janitor permanently removes
tombstoned rows after the configured grace period.

**Reversible**: only by restoring D1 from PITR. There is no undo.

```sh
polaris-email domain delete <name>
```

Mailbox- and principal-level deletes run through the admin REST surface
today.

## Quick reference

| Verb       | What it touches        | Reversible?            | Propagation      |
| ---------- | ---------------------- | ---------------------- | ---------------- |
| revoke     | credential signing key | no (rotate to restore) | ≤60 s            |
| deregister | bridge registration    | re-register            | next mirror tick |
| disable    | domain / routing rule  | enable flips back      | immediate        |
| delete     | row (tombstoned)       | only via PITR          | immediate        |

## See also

- [CLI tour](/operators/day-2/cli-tour) — workflow tour by verb domain.
- [Bridge management](/operators/day-2/bridge-management) — register /
  rotate / deregister procedures with examples.
- [Credential management](/operators/day-2/credential-management) —
  issue / rotate / revoke and the read-once secrets policy.
- [Disaster recovery](/operators/runbooks/disaster-recovery) — when
  you need to undo something this page calls irreversible.

<!-- Verified against: apps/polaris-cli/internal/cmds/{cred,bridge,domain,route}.go @ 2371f79b2274e7e0e9f39bd99a2d003bed81b472 -->
