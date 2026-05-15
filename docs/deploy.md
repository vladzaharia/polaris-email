# polaris-email — deploy runbook

This is the cold-start + infrastructure runbook. For day-to-day operator workflows
(issue api keys, onboard domains, register bridges, replay webhook DLQ entries, …)
see [`docs/operator.md`](operator.md) and the `polaris-email` CLI in
`apps/polaris-cli/README.md`.

> **Audience**: a release engineer with shell access on a workstation, the Cloudflare
> account, and the target DNS zone. ≤15 minutes from a clean clone to a green smoke is
> the design target.

---

## 1. Prerequisites (manual, one-time)

- [ ] Cloudflare account with an API token scoped: **Workers:Edit, D1:Edit, R2:Edit, Queues:Edit, KV:Edit, Email Routing:Edit, Zone:Read, DNS:Edit**.
- [ ] At least one domain on Cloudflare DNS for inbound mail.
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
5. Seeds master secrets: `POLARIS_SECRET_A`, `ARGON2_PEPPER`, `ANCHOR_SIGNING_KEY`. Creation timestamps go to `secrets.created.json` (no values).
6. `bin/deploy.sh --all` deploys every Worker in dependency order (api → out → in → fanout → cron → panel).
7. HMAC-signs `POST /v1/admin/bootstrap`, captures the returned `admin_key_id` + `admin_key_secret` into `.bootstrap-output.json` (gitignored, mode 0600) **and** prints them once.

**Copy the admin key into your password manager immediately.** It is not recoverable.

---

## 3. Smoke test

```sh
make smoke
```

Checks, in order:

1. `GET /healthz` on the api Worker → 200.
2. HMAC-signed `GET /v1/admin/status` returns counts.

Exits non-zero on any FAIL. This is the canonical definition of "deployed successfully."

---

## 4. Routine redeploy

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

## 5. Rollback

```sh
make rollback SERVICE=api
```

Runs `wrangler rollback` inside `services/<svc>`. The previous version ID is what Cloudflare tracks; `.deploy-state.json` also records the last deployed version per service for human reference.

After rollback, re-run `make smoke` to confirm.

---

## 6. Secret rotation (POLARIS_SECRET_A)

Two-phase, ≥24h apart, gated on a green smoke. See
[`docs/runbooks/control-plane-rotation.md`](runbooks/control-plane-rotation.md) for the
full procedure and rationale. The high-level shape: mint `POLARIS_SECRET_B`, deploy it
alongside A, wait for the propagation window, promote B → A, audit-log the rotation.

---

## 7. Panel (`apps/panel`)

The admin panel is a Cloudflare Worker deployed in the same account as the control plane. It is included in `bin/deploy.sh --all` and `make deploy-changed` picks it up automatically when files under `apps/panel/` change.

Local dev:

```sh
pnpm --filter @polaris-email/panel wrangler-dev
```

The panel reads sessions from D1 and authenticates operators via better-auth + OIDC (default IdP: Cloudflare Access). Provide `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` as wrangler secrets before first deploy. Use `DEV_MODE=1` only for local development.

## 8. Doctor

```sh
make doctor
```

Runs `preflight` + `smoke` + a non-destructive check of `POLARIS_SECRET_A` rotation state.

---

## 9. Manual steps that remain (and why)

These cannot be fully automated from this repo and are intentionally left as checklist items:

- **Cloudflare Email Routing enablement** (per domain): the dashboard flow needs human confirmation. Workers can only react once routing is on.
- **OIDC client creation** for the panel: the IdP is outside our control plane. Cloudflare Access is the default and recommended provider.
- **Mail bridge mode selection**: pick **tailnet-fronted** or **local / host-network** per deployment. Neither is the default; both are first-class. See [`docs/mail-bridge.md`](mail-bridge.md) and the side-by-side compose files at `apps/mail-bridge/docker-compose.tailscale.yml` / `apps/mail-bridge/docker-compose.local.yml`.

---

## State files (all gitignored)

| File                     | Purpose                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `.env.deploy`            | Environment-specific config written by `make configure`.                              |
| `.deploy-state.json`     | All Cloudflare resource IDs + last deployed version per service + rotation state.     |
| `.bootstrap-output.json` | Admin `key_id` + `key_secret` from the one-time bootstrap. **Treat as a credential.** |
| `secrets.created.json`   | Timestamps for master secret seeding (names only, no values).                         |
| `.deploy-state.last-sha` | Last SHA `bin/deploy.sh --changed` deployed, for diff computation.                    |

If you lose `.deploy-state.json`, run `make state-rebuild` (or `make state-rebuild DRY=1` to preview). It queries `wrangler d1 list`, `wrangler kv namespace list`, and `wrangler queues list`, matches resources by name, and writes a fresh state file (the previous one, if any, is backed up to `.deploy-state.json.bak.<timestamp>`). Then re-run `bin/render-wrangler-local.sh` to materialize the local configs.

---

## CI

`.github/workflows/deploy.yml` performs `make deploy-changed` + `make smoke` after the `ci` workflow succeeds on `main`, then moves the `deployed/main` tag to the new SHA. Required GitHub secrets:

- `CLOUDFLARE_API_TOKEN` — same scopes as section 1.
- `CF_ACCOUNT_ID`
- `DEPLOY_STATE_JSON` — contents of `.deploy-state.json`.
- `BOOTSTRAP_OUTPUT_JSON` — contents of `.bootstrap-output.json`.

And these repo-level _variables_ (non-secret):

- `POLARIS_API_HOSTNAME`, `ALERT_WEBHOOK`.

Workflow-dispatch with `all=true` forces `make deploy-all` instead of `--changed`.
