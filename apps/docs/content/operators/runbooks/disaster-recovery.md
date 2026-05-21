---
title: Disaster recovery
description: Recover from lost setup state, lost admin keys, bad Worker deploys, leaked secrets, and bad phase markers. The escape hatch for every cold-start mistake.
sidebar_label: Disaster recovery
sidebar_position: 10
---

# Runbook: disaster recovery

When something goes wrong in a way `setup infra` alone can't unwind,
this runbook is the escape hatch. Five failure modes are covered:

1. Lost `.deploy-state.json` — the local CF-resource ledger is gone.
2. Lost `.bootstrap-output.json` — the operator admin key is gone.
3. A Worker deploy is bad — needs to revert to the prior version.
4. A master secret leaked — needs immediate rotation + rollback path.
5. A phase marker is wrong — `--resume` is doing the wrong thing.

Every flow lands through the `polaris-mail setup infra` CLI and never
through hand-edited JSON; the CLI's atomic temp+rename writes and
flock-guarded state mutations are the integrity floor.

## Detection signals

- `polaris-mail setup infra state validate` errors `schema mismatch` or
  `no state file at .deploy-state.json`.
- `polaris-mail setup infra smoke` reports `admin-status: FAILED` with
  HTTP 401 / 403.
- A new deploy regresses production behaviour; `setup infra state show`
  reveals the current `version_id` is the bad one.
- `polaris-mail cred list` (or the panel's `audit_log` view) shows an
  unexpected `api_key.use` from outside operator IP space.

## Recover from a lost `.deploy-state.json`

The state file is the local ledger of every Cloudflare resource the
setup flow created or adopted. Losing it doesn't destroy any CF state
— the resources still exist — but every subsequent `setup infra`
phase will look at an empty ledger and try to re-create them. Rebuild
the ledger from live CF state instead:

```sh
polaris-mail setup infra state rebuild \
  --token $CLOUDFLARE_API_TOKEN \
  --account-id $CLOUDFLARE_ACCOUNT_ID
```

The rebuild lists every D1, R2, KV, and Queue under the account and
stamps each as `discovered: true`. Verify with:

```sh
polaris-mail setup infra state show
```

Then re-render wrangler configs so the new state hydrates the
`wrangler.local.jsonc` files:

```sh
polaris-mail setup infra render
```

## Recover from a lost `.bootstrap-output.json`

The admin key is gone but a SECOND admin exists (panel, another
operator). Run from that second admin's session:

```sh
# This refuses to run if the current key is the only admin key.
polaris-mail setup infra rotate-admin-key
```

This:

1. Confirms the current key is NOT the only admin (refuses otherwise).
2. Mints a fresh admin key via `POST /v1/admin/api-keys` bound to the
   same `operator` mailbox.
3. Archives the OLD `.bootstrap-output.json` to
   `.bootstrap-output.archive.json` (mode 0600, 1-deep, 7d overlap
   window).
4. Atomically replaces `.bootstrap-output.json` with the new key.

The old key is NOT auto-revoked. Validate the new key works
end-to-end (`setup infra smoke`), then revoke the old key from the
panel or via:

```sh
polaris-mail cred revoke <old-admin-key-id>
```

**If the current admin key IS the only one**, the only recovery path
is to wipe the `bootstrap` row in D1 manually so the one-time
`/v1/admin/bootstrap` endpoint can be re-consumed:

```sh
wrangler d1 execute polaris-mail --command "DELETE FROM bootstrap;"
polaris-mail setup infra   # re-runs /v1/admin/bootstrap, mints fresh key
```

This is destructive — it leaves the previous (now-orphaned) admin
key's principal in D1 without a way to authenticate, but the new
bootstrap mailbox + admin key takes over cleanly. Always prefer
`rotate-admin-key` from a second admin's session.

## Roll back a bad Worker deploy

When a deploy regresses production, roll the Worker back to its
previous version. The setup CLI's `rollback deploy` shells out to
`wrangler rollback` and re-stamps `.deploy-state.json` so the next
forward deploy carries the right ancestry:

```sh
# Use the previous version id from .deploy-state.json (the common case)
polaris-mail setup infra rollback deploy api

# Or pin an explicit version id
polaris-mail setup infra rollback deploy api --to-version <version-id>
```

After the rollback:

- `state.Deploys[api].VersionID` is the rolled-to version.
- `state.Deploys[api].PreviousVersionID` is the version we just rolled
  FROM, so a second `rollback deploy api` walks back another step
  without an explicit `--to-version`.

Chain rollbacks across multiple services in dependency order
(`api → out → in → panel`) if the regression is multi-Worker. Re-run
`setup infra smoke` after each rollback to confirm health.

## Rotate a leaked secret

If a master secret (POLARIS_SECRET_A, ARGON2_PEPPER, OIDC_CLIENT_SECRET,
…) has leaked, rotate it across every Worker via:

```sh
polaris-mail setup infra secrets rotate POLARIS_SECRET_A
```

This:

1. Reads the current value from the source chain (env, vault).
2. Mints a NEW value with the same byte-shape (base64 vs hex).
3. Archives the OLD value to `.secrets.archive.json` (mode 0600,
   1-deep).
4. Pushes the NEW value via `wrangler secret put` to every service
   the recorder lists for that name.
5. Re-stamps `secrets.created.json` with the new sha256.

**If the rotation breaks production** (the new value is rejected by
a downstream validator, or one service didn't get the push), roll
back to the archived value:

```sh
polaris-mail setup infra rollback secret POLARIS_SECRET_A
```

The archive is 1-deep — only the most recent rotation can be rolled
back. After a rollback, fix the underlying issue, then rotate again.

## Roll back a phase marker after a bad migration

The setup flow stamps each completed phase into `state.Phases[...]`.
`--resume` skips already-stamped phases. If a phase ran but produced
a wrong result (e.g. a bad migration applied to D1), the marker has
to be reset so `--resume` re-runs it:

```sh
polaris-mail setup infra rollback phase migrate
```

This:

- Resets `state.Phases["migrate"].CompletedAt` to zero.
- Prints the manual remediation steps for that phase.
- **NEVER** auto-deletes CF resources. Deleting a D1 database
  destroys customer data; deleting an R2 bucket fails (Object Lock);
  deleting a KV namespace silently kills idempotency replay
  protection mid-flight. The CLI refuses to make these decisions for
  you.

The remediation text for each phase tells you exactly what to do
manually. For `migrate`, it's "restore D1 from PITR, then re-run
`setup infra migrate` with the fixed migration." For `secrets`,
it's "use `rollback secret <name>` per-secret" — see above.

Known phase names:
`preflight`, `provision`, `render`, `migrate`, `secrets`, `deploy`,
`smoke`, `bootstrap`. Any other name is rejected.

## Why rollback never auto-deletes CF resources

The `setup infra` flow could in principle "undo" a phase by deleting
every CF resource it created. It deliberately does not, for three
reasons:

1. **D1 deletes are unrecoverable.** A `wrangler d1 delete` removes
   the database irreversibly; PITR is per-database and doesn't help
   if the database itself is gone.
2. **R2 buckets have Object Lock.** The `polaris-mail` bucket holds
   message bodies + attachments under COMPLIANCE-mode retention; objects
   refuse `DELETE` before their retain-until date, and the bucket cannot
   be deleted while it holds locked objects.
3. **KV namespaces are read mid-flight.** Idempotency replay
   protection (`POLARIS_IDEMPOTENCY`), nonce dedup
   (`POLARIS_NONCE_DEDUP`), and revocation (`KV_REVOCATIONS`) are
   queried on every authenticated request; silently dropping them
   would let a leaked-then-revoked credential succeed once.

The operator inspects `setup infra state show`, decides per-resource
which to keep, and removes them manually via `wrangler d1 delete` /
`wrangler r2 bucket delete` / `wrangler kv namespace delete`.

<!-- Verified against: docs/runbooks/disaster-recovery.md @ PR 13 -->
