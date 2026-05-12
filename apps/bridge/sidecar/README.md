# polaris-email bridge sidecar

The bridge sidecar runs on the Tailnet host alongside Mox. It:

- Polls `/v1/bridge/config` from polaris-email-api every 5s and reconciles
  state (local webhook targets, mailbox identity map, sender accounts).
- Imports inbound RFC822 into Mox via `MessageImport` (webapi/v0).
- Proxies Tailnet webhook fanout (`/hooks/:service/:rule`) to consumer apps
  on the docker network.
- Manages Mox account existence via the admin RPC API (`/admin/api/...`).

## Mox admin API surface used

| Operation | Mox method | Source |
|-----------|-----------|--------|
| Inbound import | `webapi/v0/MessageImport` | `webapi/webapi.go` |
| Account create | `admin/api/AccountAdd` | `webadmin/admin.go` |
| Account delete | `admin/api/AccountRemove` | `webadmin/admin.go` |
| Set password | `admin/api/SetPassword` | `webadmin/admin.go` |
| List accounts | `admin/api/Accounts` | `webadmin/admin.go` |

Reference: <https://www.xmox.nl/protocols/> and the linked Go files in
the `mjl-/mox` GitHub repository.

## SMTP credential trade-off (plaintext at issuance)

Mox's `SetPassword` admin RPC accepts **plaintext only** — there is no
hash-based password setter. Mox internally bcrypts at rest.

That means the sidecar cannot reconcile passwords from polaris-email's
`smtp_credentials` table (which stores PBKDF2-SHA256 hashes only). To reconcile
the world while preserving hash-at-rest in D1, polaris-email uses a one-time
hand-off:

1. Operator calls `POST /v1/admin/senders/:id/smtp-credentials` on the api
   Worker. The Worker generates a fresh plaintext, computes the hash, and
   inserts the **hash** into `smtp_credentials.password_hash`.
2. **Before** returning to the operator, the Worker fires a one-time webhook
   to the sidecar over Tailnet (`POST <sidecar>/mox/credential-set`) carrying
   the plaintext.
3. The sidecar relays plaintext to Mox via `SetPassword`, then drops the
   plaintext from process memory.
4. The Worker returns the plaintext to the operator once (as today). The
   operator hands it to whatever app needs SMTP creds.

Trade-off accepted: plaintext exists in three places for the duration of one
request — the operator's terminal, the api Worker's response buffer, and the
sidecar's transient HTTP handler. It is never persisted server-side past the
return of `SetPassword`. This is option (b) in the design doc; option (a)
would have polled hashes to Mox and is dismissed because Mox cannot consume
pre-hashed material.

**Open follow-up**: the actual `/mox/credential-set` route is not yet wired
into `server.ts`; the `mox-client.setAccountPassword(account, plaintext)`
function is in place. See the TODO in `src/server.ts` and the corresponding
section in `docs/DEPLOY.md`.

## Build / run

```sh
pnpm --filter @polaris-email/bridge-sidecar build
pnpm --filter @polaris-email/bridge-sidecar start
```

Docker image: `apps/bridge/sidecar/Dockerfile` (build context = repo root).
