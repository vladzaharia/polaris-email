# polaris-email bridge sidecar

The bridge sidecar runs on the Tailnet host alongside Mox. It:

- Polls `/v1/bridge/config` from polaris-email-api every 5s and reconciles
  state (local webhook targets, mailbox identity map, sender accounts).
- Delivers inbound RFC822 into Mox via local SMTPS submission (Mox v0.0.15
  has no JSON-RPC `MessageImport`; SMTPS @ 465 with the account's own
  credentials is the canonical injection path).
- Proxies Tailnet webhook fanout (`/hooks/:service/:rule`) to consumer
  apps on the docker network.
- Manages Mox account existence + passwords via the admin RPC API
  (`/admin/api/...`).

## Mox admin API surface used (verified against mjl-/mox v0.0.15)

| Operation       | Mox method                | Source                          |
| --------------- | ------------------------- | ------------------------------- |
| Login ceremony  | `admin/api/LoginPrep`     | `webadmin/admin.go:262`         |
|                 | `admin/api/Login`         | `webadmin/admin.go:262-272`     |
| Account create  | `admin/api/AccountAdd`    | `webadmin/admin.go:1983`        |
| Account delete  | `admin/api/AccountRemove` | `webadmin/admin.go:1989`        |
| Set password    | `admin/api/SetPassword`   | `webadmin/admin.go:2009`        |
| List accounts   | `admin/api/Accounts`      | `webadmin/admin.go:1598-1602`   |
| Submit RFC822   | SMTPS @ 127.0.0.1:465     | (nodemailer, no JSON-RPC route) |

Endpoints we previously claimed to call but do NOT exist in Mox v0.0.15:
`MessageImport`, `ConfigReload`. Both have been removed from this client.

## Wire format (sherpa)

Each admin RPC is `POST /admin/api/<Method>` with `content-type:
application/json` and body = JSON **array** of positional args (NOT an
object — sherpa parses by position). The response is always HTTP 200;
the body is either:

- a JSON value matching the method's return type;
- a JSON array for multi-return methods (e.g. `Accounts` returns
  `[allNames, disabledNames]`);
- a sherpa error envelope `{"code": "user:...", "message": "..."}` — DO
  NOT treat HTTP status as the success signal; parse the body.

Admin auth is a session cookie + CSRF header (NOT HTTP basic). The
client runs `LoginPrep` -> `Login [token, "", password]` once at startup,
caches `webadminsession` + `x-mox-csrf`, and replays them on every call.
On a 401 it re-runs the ceremony exactly once.

## SMTP credential trade-off (plaintext at issuance)

Mox's `SetPassword` admin RPC accepts **plaintext only** — there is no
hash-based password setter. Mox internally derives bcrypt + CRAM-MD5 +
SCRAM-SHA-1 + SCRAM-SHA-256 from the plaintext at write time
(`store/account.go:2525`).

That means the sidecar cannot reconcile passwords from polaris-email's
hash-only `smtp_credentials` table. The handoff is: the api Worker
issues a credential, writes the hash to D1, and enqueues a
`mox_pending_ops` row containing the plaintext (base64). The sidecar
polls, decodes, calls `SetPassword`, acks, and the api Worker's janitor
purges the row. Plaintext lives in D1 for ~5s.

## Build / run

```sh
pnpm --filter @polaris-email/bridge-sidecar build
pnpm --filter @polaris-email/bridge-sidecar start
```

Docker image: `apps/bridge/sidecar/Dockerfile` (build context = repo root).
