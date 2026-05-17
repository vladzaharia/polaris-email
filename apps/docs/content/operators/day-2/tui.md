---
title: polaris-email TUI
description: The fullscreen tabbed admin TUI — same eight tabs locally (`polaris-email tui`) or over SSH (`polaris-email serve --ssh`). Identity, polling, keymap, embedding under Wish.
sidebar_label: Admin TUI
sidebar_position: 2
---

The `polaris-email` binary ships a fullscreen tabbed admin TUI. It's the
primary day-2 interface for operators — same eight tabs whether you launch
it locally (`polaris-email tui`) or SSH into a Wish-fronted bastion
(`polaris-email serve --ssh`).

## Launch

```sh
# Local — defaults to the active credstore profile
polaris-email
polaris-email tui                       # explicit
polaris-email tui --theme=mocha         # macchiato | mocha | frappe | latte

# Over SSH (operator-side)
wishlist                                # via your Wishlist directory
ssh -p 2222 polaris.internal            # direct
```

`polaris-email` with no positional args opens the TUI when stdout is a
TTY; piping (`polaris-email | head`) falls back to the cobra help text so
scripts aren't broken by the alt-screen escape sequences.

## Tabs

| #   | Tab            | Refresh | Lists what                                                                               |
| --- | -------------- | ------- | ---------------------------------------------------------------------------------------- |
| 1   | Dashboard      | 5–30s   | KPI cards + DLQ sparkline + audit anchor freshness + bridge health + recent admin alerts |
| 2   | Mailboxes      | 30s     | `/v1/admin/mailboxes` with a detail pane                                                 |
| 3   | Domains        | 60s     | `/v1/admin/domains` with verification status                                             |
| 4   | Credentials    | 60s     | `/v1/admin/credentials` (mailbox-scoped facade over api_keys + smtp_credentials)         |
| 5   | Webhooks / DLQ | 10–30s  | Subscriptions + DLQ entries on a split pane (`tab` toggles focus)                        |
| 6   | Bridges        | 30s     | Registered SMTP/IMAP bridges with last-seen freshness                                    |
| 7   | Audit          | 30s     | Most-recent `audit_log` entries; selecting a row opens its detail in the right pane      |
| 8   | Logs           | SSE     | Live `/v1/admin/logs/stream` (reuses the existing `logs --follow` model)                 |

## Keymap

Global:

| Key              | Action                          |
| ---------------- | ------------------------------- |
| `q`, `ctrl+c`    | Quit                            |
| `tab`, `→`       | Next tab                        |
| `shift+tab`, `←` | Previous tab                    |
| `1`–`8`          | Jump to tab N                   |
| `r`              | Force-refresh the active tab    |
| `?`              | Help overlay (when implemented) |

Per-tab keys are surfaced in the status-bar hint line and inherited from
`bubbles/table` (`↑/k` `↓/j` move, `pgup/pgdn` page, etc.).

Mouse: the tab bar is clickable (via `bubblezone`). Modern xterm-compatible
terminals work over SSH provided a PTY is allocated (`ssh -t`).

## Identity + auth

The TUI is identity-agnostic — it always uses whichever `*client.Client`
it was given:

- **Local:** the CLI's `MakeClient()` resolves credentials in priority
  order: `--token` flag → `$POLARIS_TOKEN` → OS keychain (per
  `polaris-email login`) → legacy `~/.config/polaris-email/config.toml`.
- **Over SSH:** the Wish handler injects an
  `X-Polaris-OBO: operator:<id>` header on every outbound
  request via an HTTP-transport wrapper, so audit attribution names the
  human regardless of which key signed.

See `docs/operator.md` for the operator-enrollment + login flow.

## Polling model

- Each tab declares its own refresh interval.
- The `polling.Poller` runs the active tab's jobs only; switching tabs
  blurs the outgoing one (its jobs pause) and focuses the incoming.
- `r` force-refreshes every active job + the tab's own ad-hoc fetch.
- Errors are coalesced: a failed fetch backs off exponentially (capped at
  60s) and surfaces in the tab footer.

## Charts (ntcharts)

The Dashboard uses [`ntcharts`](https://github.com/NimbleMarkets/ntcharts)
for the DLQ-depth sparkline. The API only exposes aggregate counts
today, so the sparkline accumulates ~10 minutes of samples across the
session (via `internal/tui/history`'s ring buffer).

To add more charts:

1. Add a `Ring[T]` to the Dashboard model.
2. Push a value on every polling result.
3. Render via `sparkline.New(w, h)` + `.Push(v)` + `.Draw()` + `.View()`.

Per-credential / per-domain mini-charts can use the same pattern on the
detail panes.

## Embedding under Wish

`internal/tui/app.NewProgram(opts)` is I/O-injectable:

```go
p := tuiapp.NewProgram(tuiapp.ProgramOpts{
    Ctx:    sess.Context(),
    Client: operatorBoundClient,
    Theme:  "macchiato",
    In:     sess,      // ssh.Session
    Out:    sess,
    AltScreen: true,
    Extra:  bubbletea.MakeOptions(sess),
})
```

The Wish handler (`internal/sshserver/handler.go`) wraps the bootstrap
client's HTTP transport with `oboTransport` so every request carries the
operator's `X-Polaris-OBO` header. No SDK changes required.

## Theme

catppuccin variants via `github.com/catppuccin/go@v0.3.0`. Default is
`macchiato`. The `--theme` persistent flag is honored by both
`polaris-email tui` and the no-args launch path.
