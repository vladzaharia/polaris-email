# @polaris-mail/cli-installer

Cloudflare Worker that hosts the POSIX-sh installer for the `polaris-mail`
CLI at `https://cli.mail.plrs.im`.

```sh
curl -fsSL cli.mail.plrs.im | sh                # install latest
curl -fsSL cli.mail.plrs.im | sh -s -- install  # install (explicit)
curl -fsSL cli.mail.plrs.im | sh -s -- upgrade  # install / upgrade
curl -fsSL cli.mail.plrs.im | sh -s -- <args>   # install if missing, then `polaris-mail <args>`
curl -fsSL "cli.mail.plrs.im/?v=v1.2.3" | sh    # install pinned version v1.2.3
```

## Source of truth

The installer script itself lives at
[`src/install.sh`](./src/install.sh). Everything in this Worker is wrapping
paper: the Worker reads the script as a text module, optionally rewrites the
`POLARIS_PIN_VERSION=` line when the request has a `?v=<tag>` query
parameter (validated against a safe-version regex), and serves it as
`text/x-shellscript`.

To change installer behaviour, edit `src/install.sh` and redeploy:

```sh
pnpm --filter @polaris-mail/cli-installer test    # vitest + shellcheck
pnpm --filter @polaris-mail/cli-installer deploy
```

## Endpoints

| Path           | Description                      |
| -------------- | -------------------------------- |
| `GET /`        | Install script.                  |
| `GET /sh`      | Alias of `/`.                    |
| `GET /healthz` | `{ "ok": true }` liveness probe. |

`?v=<tag>` on `/` or `/sh` pins the install to a release tag. The Worker
validates the value against `/^v?[0-9]+(\.[0-9]+){0,2}(-[A-Za-z0-9.]+)?(\+[A-Za-z0-9.]+)?$/`
and caps the length at 64 chars before substituting it into the script.

## Tests

```sh
pnpm --filter @polaris-mail/cli-installer run typecheck
pnpm --filter @polaris-mail/cli-installer run lint
pnpm --filter @polaris-mail/cli-installer run test
shellcheck -s sh apps/cli-installer/src/install.sh   # CI gates this
```
