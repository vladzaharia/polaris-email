# polaris-email — deploy runbook

This is the single ordered runbook for standing up, redeploying, and operating polaris-email.
Every command here is wrapped behind `make`; the underlying logic lives in `bin/*.sh`. If a
step asks you to do something manual, the *why* is called out in section 9.

> **Audience**: a release engineer with shell access on a workstation, the Cloudflare account,
> the target DNS zone, and (optionally) a Tailnet for the bridge host. ≤15 minutes from a
> clean clone to a green smoke is the design target.

---

## 1. Prerequisites (manual, one-time)

- [ ] Cloudflare account with an API token scoped: **Workers:Edit, D1:Edit, R2:Edit, Queues:Edit, KV:Edit, Email Routing:Edit, Zone:Read, DNS:Edit**.
- [ ] At least one domain on Cloudflare DNS for inbound mail.
- [ ] (Optional) A Tailscale tailnet + an **OAuth client** for the bridge host. Create at Tailscale admin → Settings → OAuth clients → New OAuth client. **Scopes:** `devices:write`. **Tags:** `tag:mail-bridge`. Copy the secret — it's shown once. (One-time `tskey-auth-` keys are rejected by preflight; OAuth is the only supported path.)
- [ ] (Optional) An OIDC provider client for the admin panel (`apps/panel`).
- [ ] Local tools: `git`, `pnpm` ≥ 9, `wrangler` (installed via `pnpm install`), `jq`, `openssl`, `curl`.

Validate everything is in place:

```sh
wrangler login
make preflight
```

`make preflight` is a hard gate. Each failing check prints its remediation on the next line.

---

## 2. Cold start

```sh
make configure       # interactive — writes .env.deploy (gitignored, mode 0600)
make bootstrap       # runs preflight, then bin/bootstrap.sh end-to-end
```

`make bootstrap` performs the following, idempotently:

1. `pnpm install --frozen-lockfile` and `pnpm -r run build`.
2. Creates **D1** (`polaris-email`), **R2** (`polaris-email`, EU jurisdiction, 90d compliance lock), **4 KV namespaces** (nonce, idempotency, rate-limit, key-cache), **5 Queues** (outbound, inbound, fanout, + 2 DLQs). All IDs are captured into `.deploy-state.json` (gitignored). Reruns skip already-known resources.
3. Renders `services/*/wrangler.local.jsonc` from each `wrangler.local.template.jsonc` using `.deploy-state.json` + `.env.deploy`.
4. Applies D1 migrations remotely.
5. Seeds master secrets: `POLARIS_SECRET_A`, `ARGON2_PEPPER`, `FORENSIC_MASTER_KEY`, `ANCHOR_SIGNING_KEY`. Creation timestamps go to `secrets.created.json` (no values).
6. `bin/deploy.sh --all` deploys every Worker in dependency order (forensic → api → out → in → fanout → synthetic → janitor → staleness → anchor).
7. HMAC-signs `POST /admin/bootstrap`, captures the returned `admin_key_id` + `admin_key_secret` into `.bootstrap-output.json` (gitignored, mode 0600) **and** prints them once.
8. Prints the remaining manual checklist.

**Copy the admin key into your password manager immediately.** It is not recoverable.

---

## 3. Onboarding a domain

The single converge command is **`make onboard`** — Terraform-style. With no arguments it reconciles every outbound domain in D1 against Cloudflare. Pass `DOMAIN=name` to scope to one. Pass `NEW=1` together with `DOMAIN=name` to create the D1 row first.

```sh
make onboard-plan                          # dry-run: prints + CREATE / - DELETE / ~ UPDATE lines
make onboard                               # apply: same diff, then writes
make onboard DOMAIN=plrs.im NEW=1          # add a new domain end-to-end
```

Per domain, `bin/onboard.sh` will:

1. Resolve (and cache to D1) the Cloudflare zone id.
2. List current zone DNS records.
3. Compute desired MX (`route{1,2,3}.mx.cloudflare.net`), SPF (`v=spf1 include:_spf.mx.cloudflare.net -all`), DKIM CNAMEs (from CF Email Routing for the zone), and DMARC at `p=none` by default.
4. Plan/apply only records tagged `comment: "polaris-email"` — never touches operator-managed records.
5. Enable Cloudflare Email Routing on the zone (idempotent).
6. Ensure a catch-all rule named `polaris-email-catchall` pointing at the `polaris-email-in` Worker.
7. Call `bin/render-send-email-bindings.sh` so `services/out/wrangler.local.jsonc` gets a fresh `send_email` array. Operator then runs `make deploy SERVICE=services/out`.

Manual fallback — the deprecated `make dns DOMAIN=…` now just forwards to `make onboard-plan`.

---

## 4. (Optional) Bring up the bridge

Only needed if you want SMTPS/IMAP/JMAP for legacy clients. Run on the bridge host (must have Docker + access to your tailnet):

```sh
make bridge-up
```

Wraps `apps/bridge/docker-compose.yml`: pulls images, brings up `ts`, runs `cert-init`, brings up `mox` + `sidecar`, polls `http://${BRIDGE_HOST}:8088/health` for up to 60s. The first run issues a dedicated bridge API key (`scopes=bridge:read,bridge:write`) via the admin key and writes it to `apps/bridge/.env`.

The rendered `apps/bridge/.env` contains `TS_AUTHKEY=<tskey-client-…>?preauthorized=true&ephemeral=false` — the Tailscale container reads `TS_AUTHKEY` regardless of whether the value is a one-time auth-key or an OAuth client secret, and exchanges OAuth secrets for a fresh auth key on each cold boot. The `preauthorized` + `ephemeral=false` params let the minted device skip admin approval and survive container restarts via the `ts-state/` volume.

To stop without destroying volumes: `make bridge-down`.

---

## 5. Smoke test

```sh
make smoke
```

Checks, in order:

1. `GET /healthz` on the api Worker → 200.
2. HMAC-signed `GET /v1/admin/diagnostics` (using `.bootstrap-output.json`) returns `ok:true`.
3. (If `BRIDGE_HOST` is set non-default) `http://${BRIDGE_HOST}:8088/health` → 200.
4. Enqueues a synthetic outbound to `SYNTHETIC_TO` and polls `/v1/messages/{id}` for up to 60s until `status=delivered`.

Exits non-zero on any FAIL. This is the canonical definition of "deployed successfully."

---

## 6. Adding a new consumer

```sh
make issue-key NAME=acme SCOPES=mail:send
make register-consumer NAME=acme \
  WEBHOOK=https://acme.example/polaris \
  KIND=external \
  EVENTS=delivered,bounced,deferred
```

`issue-key` calls `POST /v1/admin/api-keys` and prints `KEY_ID` + `KEY_SECRET` once. Pass `OUT=file:/path/to/acme.json` to also write a mode-0600 JSON file.

`register-consumer` calls `POST /v1/admin/webhook-subs` and prints the per-subscription signing secret. Hand both off to the consumer in your usual secret-share channel.

---

## 7. Adding a new sending domain

Single command, no template editing:

```sh
make onboard DOMAIN=newdomain.example NEW=1
make deploy SERVICE=services/out
```

`onboard` creates the `outbound_domains` row in D1 (via the admin API), converges DNS + Email Routing on Cloudflare, and re-renders `services/out/wrangler.local.jsonc` with the new `EMAIL_<TAG>` binding (e.g. `EMAIL_NEWDOMAIN_EXAMPLE`). The `make deploy` pushes the binding to the Worker.

To attach senders + SMTP credentials (for the bridge / SMTPS submission path):

```sh
# Add a sender under the domain (returns its id).
curl -X POST .../v1/admin/outbound-domains/<id>/senders -d '{"local_part":"noreply","default_for_domain":true}'
# Issue an SMTP credential. Plaintext is returned once.
curl -X POST .../v1/admin/senders/<sender_id>/smtp-credentials -d '{"label":"app-prod"}'
```

The bridge sidecar polls `/v1/bridge/config` every 5s and converges **Mox account existence** accordingly. It does NOT push password hashes (Mox's admin RPC accepts plaintext only — see `apps/bridge/sidecar/README.md`).

**SMTP credential plaintext hand-off** — at credential issuance, the api Worker fires a one-time Tailnet webhook to the sidecar carrying the plaintext, which is relayed to Mox via the `SetPassword` admin RPC and immediately forgotten. The Worker stores only the PBKDF2-SHA256 hash in `smtp_credentials.password_hash`. Plaintext therefore exists in three places for the duration of one request (operator terminal, api Worker response, sidecar HTTP handler) and is never persisted server-side. See `apps/bridge/sidecar/README.md` for the rationale and trade-off.

Single-selector DKIM (`cf2024-1`) covers Worker-originated mail; a separate `mox._domainkey` selector for Mox-originated SMTPS mail is tracked in the open-questions section of the design doc and will land in a follow-up.

---

## 8. Routine redeploy

The preferred path after the initial bootstrap is the changed-only deploy:

```sh
make deploy-changed
```

`bin/deploy.sh --changed` computes `git diff --name-only $(deployed/main)..HEAD`, maps:

- files under `services/<svc>/...` → deploy that service
- files under `packages/<pkg>/...` → look up which services import `<pkg>` (via every `services/*/package.json`'s workspace deps) and deploy them transitively
- changes to `bin/`, `Makefile`, `.env.deploy` → no Worker redeploy

On success, the new HEAD SHA is written to `.deploy-state.last-sha` and (in CI) the `deployed/main` tag is moved.

To force-deploy everything: `make deploy-all`.

To redeploy a single service: `make deploy SERVICE=services/api`.

---

## 9. Rollback

```sh
make rollback SERVICE=api
```

Runs `wrangler rollback` inside `services/<svc>`. The previous version ID is what Cloudflare tracks; `.deploy-state.json` also records the last deployed version per service for human reference.

After rollback, re-run `make smoke` to confirm.

---

## 10. Secret rotation (POLARIS_SECRET_A)

Two-phase, ≥24h apart, gated on a green smoke:

```sh
# Phase 1: generates a new value, puts it as POLARIS_SECRET_B on every Worker,
# records phase1_at in .deploy-state.json.
make rotate-secret NAME=POLARIS_SECRET_A
# ...stash the value in your password manager when prompted...
# wait at least 24h of green telemetry...

# Phase 2: promote B -> A, clear B, write audit row.
POLARIS_SECRET_B_VALUE='<value from password manager>' \
  make rotate-secret NAME=POLARIS_SECRET_A
```

The script refuses to advance to phase 2 if <24h have passed, or if `make smoke` fails. Use `--force` only if you understand the implications and have a runbook ticket open. See `RUNBOOKS/control-plane-rotation.md` for the full rationale.

---

## 11. Bridge re-roll / DR

See `RUNBOOKS/bridge-rebuild.md`. Once a replacement host is on the tailnet:

```sh
cd polaris-email
make bridge-up
```

uses the same `.env.deploy` and reuses the bridge API key stashed in `apps/bridge/.bridge-key.json` if present.

---

## 12. Doctor

```sh
make doctor
```

Runs `preflight` + `smoke` + a non-destructive check of `POLARIS_SECRET_A` rotation state. Safe to invoke any time you want a fast "is the stack green right now?" answer.

---

## 13. Manual steps that remain (and why)

These cannot be fully automated from this repo and are intentionally left as checklist items:

- **DNS at your registrar / authoritative DNS**: only the records inside Cloudflare zones we own can be applied via `make dns DOMAIN=… APPLY=1`. Anything else (e.g., a customer's own DNS) is theirs to add.
- **Tailscale OAuth client creation**: the OAuth client + its `devices:write` scope + the `tag:mail-bridge` permission live in the Tailscale admin console; the OAuth API doesn't expose client creation. Rotate the OAuth client there when you need to roll the secret (single-phase rotation, not the dual-slot pattern used for `POLARIS_SECRET_A`).
- **Cloudflare Email Routing enablement** (per domain): the dashboard flow needs human confirmation. Workers can only react once routing is on.
- **OIDC client creation** for the panel: the IdP is outside our control plane.
- **First-time WebAuthn enrollment** for the admin panel: by design, must happen on a trusted device.
- **Promoting `POLARIS_SECRET_B_VALUE` from your password manager** during rotation phase 2: the value never lives on disk, so the operator types it in once.

---

## State files (all gitignored)

| File | Purpose |
|---|---|
| `.env.deploy` | Environment-specific config written by `make configure`. |
| `.deploy-state.json` | All Cloudflare resource IDs + last deployed version per service + rotation state. |
| `.bootstrap-output.json` | Admin `key_id` + `key_secret` from the one-time bootstrap. **Treat as a credential.** |
| `secrets.created.json` | Timestamps for master secret seeding (names only, no values). |
| `.deploy-state.last-sha` | Last SHA `bin/deploy.sh --changed` deployed, for diff computation. |

If you lose `.deploy-state.json`, run `make state-rebuild` (or `make state-rebuild DRY=1` to preview). It queries `wrangler d1 list`, `wrangler kv namespace list`, and `wrangler queues list`, matches resources by name, and writes a fresh state file (the previous one, if any, is backed up to `.deploy-state.json.bak.<timestamp>`). Then re-run `bin/render-wrangler-local.sh` to materialize the local configs.

---

## CI

`.github/workflows/deploy.yml` performs `make deploy-changed` + `make smoke` after the `ci` workflow succeeds on `main`, then moves the `deployed/main` tag to the new SHA. Required GitHub secrets:

- `CLOUDFLARE_API_TOKEN` — same scopes as section 1.
- `CF_ACCOUNT_ID`
- `DEPLOY_STATE_JSON` — contents of `.deploy-state.json`.
- `BOOTSTRAP_OUTPUT_JSON` — contents of `.bootstrap-output.json`.

And these repo-level *variables* (non-secret):

- `POLARIS_API_HOSTNAME`, `BRIDGE_HOST`, `SYNTHETIC_MONITOR_DOMAIN`, `ALERT_WEBHOOK`, `SYNTHETIC_FROM`, `SYNTHETIC_TO`.

> Multi-domain note: `SYNTHETIC_MONITOR_DOMAIN` is *only* the home domain for the synthetic test mailbox; it does not enumerate which domains your stack can send or receive on. Sending and receiving domains live in D1's `outbound_domains` table and are managed via `make onboard DOMAIN=… NEW=1`.

Workflow-dispatch with `all=true` forces `make deploy-all` instead of `--changed`.
