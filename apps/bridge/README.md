# polaris-email bridge

Singleton Mox + sidecar deployment on a Tailnet host. All services share
the Tailscale netns (`network_mode: service:ts`) so the sidecar can reach
Mox's admin + webapi listeners over `127.0.0.1` while SMTPS/IMAPS bind on
the tailscale0 device.

## Image pinning

The Mox image is pinned to a specific tagged release (`r.xmox.nl/mox:v0.0.15`).
The upstream `:latest` tag is moving, and per the project README "new
docker images aren't (automatically) generated for new Go runtime/compile
releases" — bumping the Mox tag is the only way to pick up Go-side CVE
patches. Capture a `sha256:` digest after the first pull and append it
to the image reference for stricter pinning. Mox is pre-1.0 (`v0.0.N`)
and the project may break wire shapes between minor releases; the
sidecar's `mox-client.ts` is verified against `v0.0.15` and should be
re-verified before bumping.

## Cert architecture

Mox cannot do DNS-01 (autotls/autotls.go:5 explicitly says so) and the
bridge is not reachable on public :80/:443, so HTTP-01 / TLS-ALPN-01
also don't work. Instead, the `cert-issuer` container runs lego with
the Cloudflare DNS-01 provider and writes the cert pair to a shared
volume Mox reads via `Listeners.public.TLS.KeyCerts`.

Renewal flow: `cert-issuer` loops every 12h, calls `lego renew`, copies
the new cert into the path Mox expects, and writes `/certs/.renewed`.
Mox loads `KeyCerts` eagerly at startup and does not watch the files, so
a restart is required to pick up the new cert. Automation for the restart
is TODO; today it's a manual `docker compose restart mox` after seeing
`.renewed` change.
