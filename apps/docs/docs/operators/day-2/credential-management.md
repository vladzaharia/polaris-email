---
title: Credential management
description: Issue, list, rotate, and revoke per-mailbox API keys and SMTP credentials. Plaintext is shown exactly once. Revocation propagates in ≤60 s via the KV-backed revocationCheck.
sidebar_label: Credential management
sidebar_position: 4
---

# Credential management

Every outbound credential — API key, SMTPS password, IMAP password —
is **scoped to a single mailbox** and is shown to you **exactly once**
at issuance. The control plane stores hashes only (bcrypt for SMTP /
IMAP passwords; HMAC-key hashes for bridges; secret-cache keyed by
`key_id → hash` for API keys). There are no plaintext columns on
`principals` or `mailbox_credentials`. To "view" a secret that was
already issued, rotate it — which mints a new value and shows that
one once.

## Issue an API key

```sh
polaris-email cred issue --mailbox <mailbox-id> --type api \
    --senders "noreply@acme.com,alerts@mail.acme.com" \
    --output secret-file --output-path ./newsletter-api.key
```

The `--senders` list pins the addresses the key is allowed to use as
`from`. The control plane validates every outbound submission against
the issuing key's `sender_scopes` (the runtime form of `--senders`).

## Issue an SMTP credential

```sh
polaris-email cred issue --mailbox <mailbox-id> --type smtp \
    --senders "noreply@acme.com" \
    --output json   # for piping to op/pass
```

SMTP credentials authenticate to the on-prem
[mail bridge](/operators/concepts/mail-bridge), not directly to the
Cloudflare control plane. The bridge mirrors the
`mailbox_messages_state` view from D1 into a local SQLite store and
authenticates clients with bcrypt.

Pipe the plaintext into your secret store immediately:

```sh
polaris-email cred issue ... -o json | jq -r .secret | op item create ...
```

## List, revoke, rotate

```sh
polaris-email cred list --mailbox <mailbox-id>
polaris-email cred revoke <id>
polaris-email cred rotate <id> --planned       # demote to secondary
polaris-email cred rotate <id> --emergency     # immediate revoke + new key
```

- **Planned rotation** keeps the prior key valid (`state='retiring'`)
  while the new key bedrocks. Use this for routine 90-day rotations.
- **Emergency rotation** revokes the prior key immediately and mints a
  replacement. Use this when a key is leaked.

Revocation propagates in ≤60 s via the KV-backed
`revocationCheck` (`KV_REVOCATIONS` namespace plus a 60-second
per-Worker cache). The previous Durable Object for revocation was
retired.

## `--mailbox` is canonical; `--tenant` is deprecated

```sh
polaris-email cred issue --mailbox <mailbox-id> ...   # canonical
polaris-email cred issue --tenant <mailbox-id> ...    # deprecated alias
```

:::warning Deprecated
The `--tenant` flag is accepted as a deprecated alias for `--mailbox`
and prints a warning on stderr. Update CI scripts at your earliest
convenience; the alias will be removed in a future release.
:::

## Plaintext is shown exactly once

Every issuance and rotation prints the plaintext exactly once — at
exit, never written to logs, never echoed in audit rows. The panel
surfaces this via `SecretRevealDialog`
(`apps/panel/src/components/SecretRevealDialog.tsx`) — a single modal
you must copy out of before dismissing.

If you lose a freshly-minted plaintext, **rotate**. There is no
"reveal" endpoint.

## Cron-friendly issuance

For automation:

```sh
polaris-email cred issue --mailbox <mailbox-id> --type api \
    --senders 'a@b.com' \
    --output json | jq -r .secret | \
    op item create --category="API Credential" \
        --vault=Polaris title="$(date +%F) acme api" \
        password=- 2>/dev/null
```

The `--from-file` flag accepts the same JSON / YAML shape; see
[`apps/polaris-cli/testdata/wizard-schemas/cred.json`](https://github.com/vladzaharia/polaris-email/blob/main/apps/polaris-cli/testdata/wizard-schemas/cred.json)
for the schema.

## `--dry-run`

Every mutating `cred` command honours `--dry-run`: it signs the
request, prints the canonical `METHOD URL` plus headers (signature
redacted) and JSON body, and returns immediately without sending the
request. Useful for CI preview mode.

```sh
polaris-email cred issue --mailbox <mailbox-id> --type smtp \
    --senders 'a@b.com' --dry-run
polaris-email cred rotate <id> --planned --dry-run
```

## Related runbooks

- [Operators](/operators) → Runbooks → `credential-rotation` — the
  on-call playbook when a key is suspected leaked (lands in a later
  batch).
- [Operators](/operators) → Runbooks → `key-rotation` — the broader
  control-plane key-rotation procedure for HMAC, anchor signing,
  panel session, and the B2 anchor application key (lands in a later
  batch).
- [Control-plane rotation](/operators/runbooks/control-plane-rotation) —
  end-to-end rotation across all credential surfaces.

<!-- Verified against: docs/operator.md @ c3c1b5048dd5bfe92facdce24982141a07446042 -->
