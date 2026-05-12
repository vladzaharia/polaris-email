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
- [ ] (Optional) A Tailscale tailnet + a reusable, tagged auth key (`tag:mail-bridge`) for the bridge host.
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

## 3. DNS records (manual)

For every domain you want to receive or send mail from:

```sh
make dns DOMAIN=example.com
```

Prints the exact MX / SPF / DKIM / DMARC records to add. With `APPLY=1` and `CF_API_TOKEN` + `CF_ZONE_ID` in `.env.deploy`, the script pushes MX / SPF / DMARC via the CF API; DKIM CNAMEs still require the **Email Routing** dashboard to enable, since they are account-scoped.

```sh
make dns DOMAIN=example.com APPLY=1
```

Then in the Cloudflare dashboard:

- [ ] Email Routing → Routes: target `polaris-email-in.workers.dev`.
- [ ] Email Routing → DNS Records: copy DKIM CNAMEs from the dashboard (selector `cf2024-1`) into your authoritative DNS if not already pushed.

---

## 4. (Optional) Bring up the bridge

Only needed if you want SMTPS/IMAP/JMAP for legacy clients. Run on the bridge host (must have Docker + access to your tailnet):

```sh
make bridge-up
```

Wraps `apps/bridge/docker-compose.yml`: pulls images, brings up `ts`, runs `cert-init`, brings up `mox` + `sidecar`, polls `http://${BRIDGE_HOST}:8088/health` for up to 60s. The first run issues a dedicated bridge API key (`scopes=bridge:read,bridge:write`) via the admin key and writes it to `apps/bridge/.env`.

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

1. `make dns DOMAIN=newdomain.example` — add the printed records to DNS.
2. Edit `services/out/wrangler.local.template.jsonc` and add a `send_email` binding entry of the form
   `{ "name": "EMAIL_<TAG>", "destination_address": "outbound@newdomain.example" }`.
3. `bin/render-wrangler-local.sh` — regenerate `services/out/wrangler.local.jsonc`.
4. `make deploy SERVICE=services/out` (or `make deploy-changed` if the template change is committed).

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
- **Tailscale auth key minting**: tailnet credentials live in your Tailscale admin console, not in this repo.
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

- `POLARIS_DOMAIN`, `POLARIS_API_HOSTNAME`, `BRIDGE_HOST`, `ALERT_WEBHOOK`, `SYNTHETIC_FROM`, `SYNTHETIC_TO`.

Workflow-dispatch with `all=true` forces `make deploy-all` instead of `--changed`.
