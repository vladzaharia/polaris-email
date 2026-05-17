---
title: Cold-start bootstrap
description: One-time cold-start that creates Cloudflare resources, seeds master secrets, deploys all four Workers, and mints the admin key. Run after prerequisites are green.
sidebar_label: Cold-start bootstrap
sidebar_position: 2
---

# Cold-start bootstrap

This is the one-time path from an empty Cloudflare account to a green
`make smoke`. Run it once per deployment — after that, you live on
[routine redeploy](/operators/runbooks) and the
[on-call runbook](/operators/runbooks). The
[prerequisites](/operators/deployment/prerequisites) page must be green
first.

## Two paths during the soak window

Two cold-start flows are supported in parallel. Pick one:

- **Shell flow (`make bootstrap`).** The original orchestrator —
  `make configure` + `bin/bootstrap.sh`. Battle-tested, every step is
  visible in the shell scripts under `bin/`.
- **Go CLI flow (`polaris-email setup infra`).** The new canonical
  command — a single Go binary that retires the shell-script flow with
  resumable phases, atomic state writes, and `huh`-based prompts. This is
  what new deployments should use post-soak.

Both produce the same result and consume the same `.env.deploy` /
`.deploy-state.json`. The shell flow is being retired during the
current soak window; once the soak completes, this page will collapse to
the CLI flow only. If you are picking polaris-email up fresh today,
prefer `polaris-email setup infra`.

## Configure

```sh
make configure
```

Interactive — writes `.env.deploy` (gitignored, mode `0600`). Prompts for
everything that has to land as a wrangler secret on the deployed
Workers, including:

- `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` (panel auth — leave blank to
  skip the panel).
- `ANCHOR_S3_ENDPOINT`, `ANCHOR_S3_BUCKET`, `ANCHOR_S3_REGION`,
  `ANCHOR_S3_ACCESS_KEY_ID`, `ANCHOR_S3_SECRET_ACCESS_KEY` — required;
  see [prerequisites](/operators/deployment/prerequisites).
- The alert webhook and the production hostname.

`BRIDGE_HMAC_KEY` is **not** a global secret. Each bridge gets its own
HMAC key minted at registration (`polaris-email bridge register <name>`);
the secret is delivered exactly once in the response and stored under
that bridge's `BRIDGE_<NAME>_HMAC_KEY` slot. There is no shared bridge
secret to seed at bootstrap.

## Bootstrap

```sh
make bootstrap
```

Runs `preflight`, then `bin/bootstrap.sh` end-to-end. Idempotent — every
phase reruns safely on the same `.deploy-state.json`. The phases are:

1. `pnpm install --frozen-lockfile` + `pnpm -r run build`.
2. Create the Cloudflare resources:
   - **D1**: `polaris-email`.
   - **R2**: `polaris-email`, EU jurisdiction, 90d compliance lock.
   - **5 KV namespaces**: nonce, idempotency, rate-limit, key-cache,
     and `KV_REVOCATIONS`. `KV_REVOCATIONS` backs the synchronous
     credential-revocation path (the previous Durable Object that owned
     this state was retired).
   - **3 Queues + 2 DLQs**: inbound and outbound queues each have their
     own dead-letter queue, plus `polaris-email-fanout` for webhook
     delivery (consumed by `services/api`).

   Every resource ID is captured into `.deploy-state.json` (gitignored).
   Reruns skip already-known resources.
3. Render `services/*/wrangler.local.jsonc` from each
   `wrangler.local.template.jsonc` using `.deploy-state.json` plus
   `.env.deploy`. Do not hand-edit the materialised files.
4. Apply D1 migrations remotely.
5. Seed master secrets: `POLARIS_SECRET_A`, `ARGON2_PEPPER`,
   `ANCHOR_SIGNING_KEY`. Creation timestamps go to
   `secrets.created.json` — names only, no values.
6. `bin/deploy.sh --all` deploys the four Workers in dependency order:
   `polaris-email-api` → `polaris-email-out` → `polaris-email-in` →
   `polaris-email-panel`. The previous `services/fanout` and
   `services/cron` Workers were folded into `services/api`.
7. HMAC-sign `POST /v1/admin/bootstrap`. The response carries the
   `admin_key_id` and `admin_key_secret`. Both are captured into
   `.bootstrap-output.json` (gitignored, mode `0600`) **and** printed
   once.

**Copy the admin key into your password manager immediately.** It is not
recoverable.

## After the bootstrap

Open the admin panel and visit **`/cf-zones`**. Every Cloudflare zone in
the account appears with a six-badge status grid. Click the zones you
want polaris-email to handle and apply the diff — that is the primary
onboarding path post-deploy. See the
[domain-onboarding runbook](/operators/runbooks) for the full flow.

## Smoke

```sh
make smoke
```

Checks, in order:

1. `GET /healthz` on the API Worker → `200`.
2. HMAC-signed `GET /v1/admin/status` returns counts.

Exits non-zero on any FAIL. This is the canonical definition of
"deployed successfully".

## State files

All gitignored, all material. If you lose `.deploy-state.json`, run
`make state-rebuild` (or `make state-rebuild DRY=1` to preview).

| File                     | Purpose                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `.env.deploy`            | Environment-specific config written by `make configure`.                              |
| `.deploy-state.json`     | All Cloudflare resource IDs + last deployed version per service + rotation state.     |
| `.bootstrap-output.json` | Admin `key_id` + `key_secret` from the one-time bootstrap. **Treat as a credential.** |
| `secrets.created.json`   | Timestamps for master secret seeding (names only, no values).                         |
| `.deploy-state.last-sha` | Last SHA `bin/deploy.sh --changed` deployed, for diff computation.                    |

`state-rebuild` queries `wrangler d1 list`, `wrangler kv namespace list`,
and `wrangler queues list`, matches resources by name, and writes a fresh
state file. The previous one (if any) is backed up to
`.deploy-state.json.bak.<timestamp>`. Re-run
`bin/render-wrangler-local.sh` afterwards to materialise the local
configs.

## Manual steps that remain

These cannot be fully automated from this repo and stay as checklist
items:

- **Cloudflare Email Routing enablement** (per domain): the dashboard
  flow needs human confirmation. Workers can only react once routing is
  on.
- **OIDC client creation** for the panel: the IdP is outside our
  control plane. Cloudflare Access is the default and recommended
  provider.
- **Mail bridge mode selection**: pick **tailnet-fronted** or
  **local / host-network** per deployment. Neither is the default;
  both are first-class. See [mail-bridge concepts](/operators/concepts/mail-bridge)
  and the side-by-side compose files at
  `apps/mail-bridge/docker-compose.tailscale.yml` /
  `apps/mail-bridge/docker-compose.local.yml`.

## Doctor

```sh
make doctor
```

Runs `preflight` + `smoke` + a non-destructive check of
`POLARIS_SECRET_A` rotation state. Use this as a quick read of overall
health between deploys.

## Next

- [Custom domains](/operators/deployment/custom-domains) — DNS, R2
  public domain, Workers custom hostnames.
- [On-call runbook](/operators/runbooks) — day-to-day operations.
- [CLI reference](/reference/cli) — the `polaris-email` operator
  surface.

<!-- Verified against: docs/deploy.md @ c3c1b5048dd5bfe92facdce24982141a07446042 -->
