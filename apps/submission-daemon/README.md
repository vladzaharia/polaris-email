# polaris-daemon

On-prem implicit-TLS SMTP submission daemon for Polaris. Authenticates SMTP
clients against a SQLite mirror of daemon credentials, canonicalizes RFC 5322,
and forwards to the Polaris API at `/v1/send/raw`.

## Build

```bash
make build      # native binary at bin/polaris-daemon
make test       # unit tests
make docker     # builds polaris-daemon:dev (CGO disabled, modernc.org/sqlite)
```

## Run

```bash
POLARIS_API_URL=https://api.polaris.example.com \
DAEMON_NAME=polaris-daemon-1 \
DAEMON_ID=01J... \
DAEMON_HMAC_KEY_FILE=/etc/polaris/hmac.key \
ACCESS_CLIENT_ID=... \
ACCESS_CLIENT_SECRET=... \
TLS_CERT=/etc/polaris/cert.pem \
TLS_KEY=/etc/polaris/key.pem \
SQLITE_PATH=/var/lib/polaris-daemon/credstore.db \
AUDIT_LOG_PATH=/var/log/polaris-daemon/audit.log \
./bin/polaris-daemon
```

## Environment variables

| Variable                                   | Required | Default                                | Description                             |
| ------------------------------------------ | -------- | -------------------------------------- | --------------------------------------- |
| `POLARIS_API_URL`                          | yes      | —                                      | Base URL of the Polaris API.            |
| `DAEMON_NAME`                              | yes      | —                                      | Hostname used for SMTP `EHLO`.          |
| `DAEMON_ID` / `DAEMON_ID_FILE`             | one of   | —                                      | Daemon ULID.                            |
| `DAEMON_HMAC_KEY` / `DAEMON_HMAC_KEY_FILE` | one of   | —                                      | Shared HMAC secret.                     |
| `ACCESS_CLIENT_ID`                         | yes      | —                                      | Cloudflare Access service token id.     |
| `ACCESS_CLIENT_SECRET`                     | yes      | —                                      | Cloudflare Access service token secret. |
| `TLS_CERT`                                 | yes      | —                                      | PEM cert path (hot-reloaded).           |
| `TLS_KEY`                                  | yes      | —                                      | PEM key path.                           |
| `LISTEN_ADDR`                              | no       | `:465`                                 | Implicit-TLS SMTPS listen addr.         |
| `POLL_INTERVAL`                            | no       | `5s`                                   | Credential mirror poll interval.        |
| `MAX_MESSAGE_SIZE`                         | no       | `26214400`                             | Bytes.                                  |
| `SQLITE_PATH`                              | no       | `/var/lib/polaris-daemon/credstore.db` | Mirror DB.                              |
| `AUDIT_LOG_PATH`                           | no       | `/var/log/polaris-daemon/audit.log`    | JSON-lines audit.                       |

## Multi-host operation

Each host runs its own daemon with a unique `DAEMON_ID` and HMAC key. The
credential mirror is per-host — daemons do not coordinate. Bridge revocations
propagate within `POLL_INTERVAL`. Upstream uses `X-Polaris-Daemon-Id` to
disambiguate forwarded submissions.

## Troubleshooting

- **Auth always fails** — verify the daemon synced credentials at least once
  (`mirror_version` log line). Until then, all logins fail. Check Cloudflare
  Access tokens and HMAC key match the daemon credential-mirror config.
- **TLS handshake fails** — confirm `TLS_CERT`/`TLS_KEY` are readable by the
  `polaris` user (uid present in container) and contain matching key material.
- **Upstream 4xx → 451** — the API returned a transient error (timeout, 429,
  5xx). Sender retries. Permanent 4xx → 554; sender should not retry.
- **`forbidden_header` rejections** — the submitter set a header reserved for
  relays (`Received`, `DKIM-Signature`, etc.). Strip it client-side.

## Layout

```
cmd/polaris-daemon/   entry point
internal/config/      env loader
internal/audit/       JSON-lines local audit log
internal/credstore/   SQLite mirror + HMAC poller
internal/forwarder/   POST /v1/send/raw
internal/mime/        strict RFC 5322 canonicalizer (port of packages/mime)
internal/smtp/        go-smtp Backend / Session
```
