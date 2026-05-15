# polaris-email CLI vocabulary

The `polaris-email` CLI (and the panel admin UI) use four distinct verbs for
state changes that look superficially similar. They are not interchangeable.
Pick the one that matches the intent; the CLI will reject mismatches.

## revoke

**Target**: a credential (API key, SMTPS password, IMAP password, bridge HMAC
key).

**Effect**: the signing material is invalidated immediately. The credential
row remains in the database (for audit) but cannot authenticate any future
request. Revocation is recorded in `KV_REVOCATIONS` and propagates to all
Workers within ≤60 s (KV write + 60 s per-Worker cache).

**Reversible**: no. To restore access, rotate the credential — which mints a
new secret and shows it once.

```sh
polaris-email credential revoke <key_id>
polaris-email bridge revoke <bridge_id>     # revokes the bridge's HMAC key
```

## deregister

**Target**: a bridge.

**Effect**: the bridge is disabled (cannot authenticate to the control plane)
and its mailbox-credential mirror is marked stale. The row is soft-removed
(`deregistered_at` set); credentials owned by other bridges are unaffected.

**Reversible**: re-register with the same `bridge_id` to undo within a short
window; after the tombstone GC runs the ID is permanently retired.

```sh
polaris-email bridge deregister <bridge_id>
```

## disable

**Target**: a mailbox, a domain, a webhook subscription.

**Effect**: soft state change. The row stays; a `disabled_at` (or
`paused_at`) timestamp is set. Inbound/outbound traffic to or from the
target is rejected with a clear error code while it is disabled.

**Reversible**: yes — `polaris-email <thing> enable <id>` flips the flag
back and the same row resumes serving traffic.

```sh
polaris-email mailbox disable <mailbox_id>
polaris-email webhook disable <sub_id>
```

## delete

**Target**: a mailbox, a domain, a webhook subscription, a principal.

**Effect**: hard removal. The row is tombstoned (`deleted_at` set) and FK
constraints to dependent rows are checked first — you cannot delete a
mailbox that still owns messages, principals, or webhook subs without an
explicit cascade flag. The retention janitor permanently removes tombstoned
rows after the configured grace period.

**Reversible**: only by restoring D1 from PITR. There is no undo.

```sh
polaris-email mailbox delete <mailbox_id> --cascade
polaris-email principal delete <principal_id>
```

## Quick reference

| Verb       | What it touches        | Reversible?            | Propagation      |
| ---------- | ---------------------- | ---------------------- | ---------------- |
| revoke     | credential signing key | no (rotate to restore) | ≤60 s            |
| deregister | bridge registration    | re-register            | next mirror tick |
| disable    | mailbox / domain / sub | enable flips back      | immediate        |
| delete     | row (tombstoned)       | only via PITR          | immediate        |

See [`operator.md`](operator.md) for the workflows that use these verbs and
[`runbook.md`](runbook.md) for incident-response procedures.
