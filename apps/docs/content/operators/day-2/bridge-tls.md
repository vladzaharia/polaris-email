---
title: Bridge TLS rotation
description: TLS source modes for the on-prem mail-bridge — mounted PEM, Lego ACME-DNS-01, Tailscale-issued — and the rotation flow plus alarms for each.
sidebar_label: Bridge TLS
sidebar_position: 2
---

# Mail-bridge TLS rotation

The bridge serves SMTPS (`:465`) and IMAP4rev2 (`:993`) with implicit
TLS only — there is no STARTTLS path and there is no plaintext
fallback. If TLS breaks, both listeners are down. This page covers
the three supported TLS source modes and the rotation flow for each.

For the broader bridge picture (architecture, deployment modes, IMAP
push flow), start at the [mail-bridge concept page](/operators/concepts/mail-bridge).

## Three TLS source modes

| Mode                 | Cert source                                                   | Compose file                                                                                        | Rotation cadence                |
| -------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------- |
| **Mounted PEM**      | Operator writes `fullchain.pem` + `privkey.pem`               | `docker-compose.local.yml`                                                                          | Operator-driven                 |
| **Lego ACME-DNS-01** | Sidecar runs `lego` against Cloudflare DNS API                | `docker-compose.local.yml` (`--profile lego`) and `docker-compose.tailscale.yml` (`--profile lego`) | Automatic at 30 d before expiry |
| **Tailscale-issued** | `tsnet.ListenTLS` (future build) / `tailscale cert` (current) | `docker-compose.tailscale.yml`                                                                      | Automatic; tsnet/CLI handles it |

The mode is selected by `BRIDGE_TLS_MODE` in the bridge's environment.
`local` is the only mode the in-tree TLS loader (`internal/tls/tls.go`)
compiles for today; `tailscale` is reserved and returns
`ErrTailscaleUnsupported` at startup — the tsnet integration is a
forward-looking enhancement not yet compiled in. Until that lands,
"Tailscale-issued" certs are obtained out-of-band (`tailscale cert <fqdn>`
on the sidecar) and consumed as mounted PEMs by the bridge.

## Hot-reload cadence

The bridge does **not** use fsnotify. Cert reloads happen in
`GetCertificate` on the per-accept path with a 30 s minimum interval:

```go
if s.cert != nil && time.Now().UnixNano()-s.certAtNS < int64(30*time.Second) {
  return s.cert, nil
}
```

Net effect: a freshly-written cert/key pair on disk is picked up on
the **first SMTPS or IMAP accept that arrives ≥30 s after the swap**.
There is no restart required. ACME renewals run on the order of
months, so the 30 s lazy reload is far below the SLA the rotation
needs.

If the new cert fails to load (mismatched key, corrupt PEM, wrong
permissions), the bridge logs `tls: reload failed, using cached cert`
and continues serving the previous cert. The reload is best-effort —
a broken rotation does not take the listeners down, it just leaves
them on the old cert. Watch the logs.

## Mode 1 — Mounted PEM

You own the certs end-to-end. The bridge expects:

```text
BRIDGE_TLS_CERT_PATH=/etc/polaris-bridge/tls/fullchain.pem
BRIDGE_TLS_KEY_PATH=/etc/polaris-bridge/tls/privkey.pem
```

`docker-compose.local.yml` mounts the host directory `${BRIDGE_TLS_DIR:-./tls}`
to `/etc/polaris-bridge/tls` read-only.

Rotation:

1. Obtain the new cert and key (Let's Encrypt via your own ACME
   tooling, an internal CA, etc.).
2. Write the new PEM pair to a staging path on the host
   (`./tls.new/fullchain.pem`, `./tls.new/privkey.pem`).
3. Atomically swap: `mv ./tls.new/fullchain.pem ./tls/fullchain.pem`
   followed by `mv ./tls.new/privkey.pem ./tls/privkey.pem`. Atomic
   `mv` on the same filesystem avoids a transient state where
   `fullchain.pem` is new but `privkey.pem` is old (which would fail
   the next reload).
4. Within 30 s the next handshake picks up the new pair.
5. Verify the live cert dates:

   ```sh
   openssl s_client -connect <bridge-fqdn>:465 -servername <bridge-fqdn> </dev/null 2>/dev/null \
     | openssl x509 -noout -dates
   ```

The bridge does not need a restart. Test the rotation in a
staging-grade tailnet ACL before doing it in production — a broken
PEM pair will not take the bridge down, but it will leave you serving
an expired cert.

## Mode 2 — Lego ACME-DNS-01

`docker-compose.local.yml` and `docker-compose.tailscale.yml` both
ship a `lego` service in a Compose profile. Activate with:

```sh
docker compose --profile lego up
```

The sidecar runs `goacme/lego:v4.14` and uses Cloudflare's DNS API
(`CLOUDFLARE_DNS_API_TOKEN`) for the `dns-01` challenge. Output
lands at `/.lego/certificates/<fqdn>.{crt,key}`, which the bridge
mounts via the shared volume.

Renewal: Lego runs once on profile up. For automated renewal at 30 d
before expiry, run the lego container on a cron or a systemd timer
that invokes `docker compose --profile lego run --rm lego` at least
weekly. Lego is a no-op when the existing cert has more than 30 d of
life, so a weekly cron is safe.

Operator-side verification:

1. Confirm the renewal cron ran:
   `journalctl -u polaris-bridge-lego-renew.timer --since yesterday`
   (or your equivalent).
2. Confirm the cert dates rolled forward:
   `openssl x509 -noout -dates -in /var/lib/polaris-bridge/tls/certificates/<fqdn>.crt`.
3. The bridge picks up the new cert on the next accept ≥30 s after
   Lego writes it. No bridge restart required.

If Lego fails (DNS API token expired, rate-limited, network), it
logs the error and exits non-zero. The systemd timer (or cron) is
where you wire alerting — see the "Alarms" section below.

## Mode 3 — Tailscale-issued

Two flavours, depending on what the build supports:

- **Today** — the `tailscale/tailscale:stable` sidecar runs
  `tailscale cert <fqdn>` ahead of time and writes the PEMs into the
  shared volume; the bridge consumes them as a mounted-PEM
  configuration. Renewal is via `tailscale cert` against the
  sidecar's tailnet state; the cert is valid for ~90 d. Cron the
  sidecar to re-run `tailscale cert` weekly.
- **Future** — `tsnet.ListenTLS` integrated directly into the bridge
  binary. `BRIDGE_TLS_MODE=tailscale` is reserved for this path. The
  binary today returns `ErrTailscaleUnsupported` if you set it; do
  not deploy with that mode until the tsnet build lands.

In either flavour, Tailscale handles the cert lifecycle on its end —
the operator's job is to confirm the renewal cron is healthy and the
bridge is reading the latest PEM.

## Alarms

Wire two alerts. **Both should page**:

1. **Cert expiry less than 14 days.** Compute against the bridge's
   live cert on `:465`:
   ```sh
   end=$(openssl s_client -connect <bridge-fqdn>:465 -servername <bridge-fqdn> </dev/null 2>/dev/null \
     | openssl x509 -noout -enddate | sed 's/notAfter=//')
   days=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 ))
   [ "$days" -lt 14 ] && echo "ALARM: cert expires in $days d"
   ```
2. **Renewal cron last-success age.** For Lego or Tailscale-cert
   rotation, alarm if the renewal job has not succeeded in the last
   7 d. The exact query depends on your scheduler:
   - systemd: `systemctl show polaris-bridge-lego-renew.timer -p LastTriggerUSec`.
   - cron with logging to a file: `find /var/log/polaris-bridge/lego -name 'success-*' -mtime -7` and alarm if empty.

If you push bridge logs to a central aggregator (Logpush via a
reverse proxy, or a Loki/Promtail sidecar), also alarm on the literal
log line `tls: reload failed, using cached cert` — that means a
rotation was attempted and the bridge fell back to the old cert.
That is recoverable but should not happen silently.

## What to do if the bridge is serving an expired cert

Symptoms: clients fail with `certificate has expired` (Thunderbird,
Apple Mail) or `x509: certificate has expired or is not yet valid`
(Go-based clients).

1. Re-run the rotation for the mode the bridge is configured with
   (mounted PEM, Lego, Tailscale). The bridge will pick up the new
   cert on the next accept ≥30 s later.
2. If the rotation succeeded but the bridge is still serving the
   expired cert, check the logs for `tls: reload failed`. The most
   common cause is a key/cert mismatch from a non-atomic swap (see
   Mode 1 step 3) — re-issue the pair and swap atomically.
3. If the rotation cannot run (Lego DNS API token revoked,
   Tailscale state lost), fall back to Mode 1 with a hand-issued
   cert. The bridge does not care which mode minted the PEMs as long
   as the files at `BRIDGE_TLS_CERT_PATH` and `BRIDGE_TLS_KEY_PATH`
   are valid.

Restarting the bridge process forces an immediate reload, but is not
required and will drop in-flight IDLE sessions. Prefer waiting for the
30 s reload window unless you are already paging.

<!-- Verified against: apps/mail-bridge/internal/tls/tls.go, apps/mail-bridge/docker-compose.local.yml, apps/mail-bridge/docker-compose.tailscale.yml @ eeee222cdf8359f8f2bf1013a103abdb3c705f06 -->
