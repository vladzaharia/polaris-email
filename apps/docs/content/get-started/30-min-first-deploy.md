---
title: 30-minute first deploy
description: Stand up polaris-mail from a cold Cloudflare account, mint your first credential, and send a test message — in roughly half an hour.
sidebar_label: 30-minute first deploy
sidebar_position: 1
slug: /get-started/30-min-first-deploy
---

# 30 minutes from zero to first send

This is the operator-side hero tutorial. You have a fresh Cloudflare
account; you want a healthy polaris-mail control plane and one
credential you can `curl` against. Domain onboarding, mail-bridge
install, and webhook subscriptions are covered in
[next steps](#next-steps) — none of them are required to finish this
tutorial.

Budget: ~30 minutes if everything is happy. The `setup infra apply`
phase is the only step that does anything irreversible.

## 0. Prerequisites (5 min)

A laptop with:

- `curl`, `jq`, `openssl`, `git` on `$PATH`.
- A modern Go toolchain (1.22+) **only if** you plan to `go install`
  the CLI; the `curl … | sh` path below is self-contained.

A **Cloudflare account** (free plan is fine for the control plane,
though Workers Paid is required for production traffic). You need
the account ID (Cloudflare dashboard → top-right corner). Mint an
**API token** with these scopes — broader than the v0 "Email Routing
on one zone" model because the CF-zone discover view enumerates
every zone in the account:

- Account → Email Routing → Edit
- Account → Workers Email Sending → Edit
- Account → Zone → Read
- Zone → Zone → Edit
- Zone → DNS → Edit

## 1. Install the CLI (1 min)

```sh
curl -fsSL https://cli.mail.plrs.im | sh
```

Or pick another channel — see
[`apps/polaris-cli/README.md`](https://github.com/vladzaharia/polaris-email/blob/main/apps/polaris-cli/README.md):

```sh
brew install vladzaharia/tap/polaris-mail
# or
go install github.com/vladzaharia/polaris-email/apps/polaris-cli/cmd/polaris-mail@latest
```

Verify:

```sh
polaris-mail --version
```

The same binary is symlinked as `pml` for keystroke-conscious folks.

## 2. Configure (5 min)

`setup infra configure` writes `.env.deploy` (gitignored, mode 0600)
from interactive prompts. Press enter to keep any default shown in
`[brackets]`.

```sh
polaris-mail setup infra configure
```

You will be asked for, in order:

| Var                    | Source                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `CF_ACCOUNT_ID`        | Cloudflare dashboard → top-right corner.                                                    |
| `POLARIS_API_HOSTNAME` | Where the API Worker will live (e.g. `polaris-mail-api.workers.dev` or a custom hostname).  |
| `CF_API_TOKEN`         | The token you minted in step 0.                                                             |
| `CF_ZONE_ID`           | Default zone for domain ops (optional).                                                     |
| `ALERT_WEBHOOK`        | Slack / PagerDuty inbound webhook for synthetic + staleness alerts (optional, recommended). |
| `OIDC_*`               | Panel auth — defer if you don't need the panel today.                                       |
| `R2_PUBLIC_HOST`       | Public R2 custom domain for message bodies + attachments (e.g. `r2.mail.example.com`).      |

The file is rewritten after every prompt, so a Ctrl-C halfway
through leaves you with a partial `.env.deploy` and the next run
defaults to what you'd already entered.

## 3. Preflight (1 min)

Sanity-check tooling, env file, and CF token scopes before anything
talks to Cloudflare:

```sh
polaris-mail setup infra preflight
```

Fix anything it complains about. The most common failure is a CF
token missing one of the five scopes above; mint a replacement, push
it into `.env.deploy`, and re-run.

## 4. Plan + apply Cloudflare resources (5 min)

Preview first — nothing is written:

```sh
polaris-mail setup infra plan
```

This computes the diff between the desired set (one D1 database,
one R2 bucket, five KV namespaces, five Queues) and what already
exists. Empty diff means you're already up.

If the plan looks right, apply:

```sh
polaris-mail setup infra apply
```

State lands atomically in `.deploy-state.json` after every successful
resource create, so a Ctrl-C / kill-9 / transient CF outage resumes
cleanly on the next `apply`. Re-running on a clean state is a no-op.

## 5. Render wrangler.local.jsonc (instant)

Each Worker has a committed `wrangler.jsonc` with placeholder IDs and
a gitignored `wrangler.local.jsonc` rendered from a template +
`.deploy-state.json`. Materialise them:

```sh
polaris-mail setup infra render
```

Do **not** hand-edit the rendered files; the next render overwrites
them. The merge model is documented in
[the project's CLAUDE.md](https://github.com/vladzaharia/polaris-email/blob/main/CLAUDE.md)
under "Wrangler config convention".

## 6. Migrate D1 (1 min)

```sh
polaris-mail setup infra migrate
```

The schema lives under each service that owns it (custom
`schema_migrations` tables, expand-then-contract pattern). D1 has no
transactional DDL — see the [on-call runbook](/operators/runbooks) for
recovery if a deploy ever rolls back mid-migration.

## 7. Seed secrets (2 min)

```sh
polaris-mail setup infra secrets seed
```

This pushes generated master secrets (`POLARIS_SECRET_A`,
`ARGON2_PEPPER`) plus any sourced optional secrets (OIDC client
secret) to each Worker via `wrangler secret put`. It records SHA-256
hashes (not plaintext) in `secrets.created.json` so re-runs are
idempotent.

The seed values stay in your shell environment for the next two
steps — write them down or stash them in your password manager
**now**, before they roll off scroll.

## 8. Deploy Workers (3 min)

```sh
polaris-mail setup infra deploy all
```

Deploys `services/api`, `services/in`, `services/out`, and the panel
(if you wired OIDC). Each Worker is deployed with the merged
`wrangler.jsonc * wrangler.local.jsonc` config via `wrangler deploy`.

## 9. Genesis seal + smoke (2 min)

The first authenticated admin key is minted via a one-shot bootstrap
signed with `POLARIS_SECRET_A` (the master secret you just seeded).
This step is called the **genesis seal** because it also writes the
first row into the chained-hash `audit_log` — every later mutation
links back to it.

```sh
polaris-mail bootstrap
```

The output prints — exactly once — the admin key id + secret. **Save
both immediately**; the secret is never recoverable. Stash it in your
password manager and export it for the rest of this session:

```sh
export POLARIS_MAIL_KEY_ID=pk_live_...
export POLARIS_MAIL_KEY_SECRET=...
export POLARIS_MAIL_URL=https://<your-POLARIS_API_HOSTNAME>
```

End-to-end smoke:

```sh
polaris-mail setup infra smoke
```

This runs `healthz`, a signed `status` call, and a synthetic outbound
send. Any red is a hard stop — fix before continuing.

## 10. Mint your first consumer credential (1 min)

The schema is mailbox-centric, so a credential is always
mailbox-bound. The smoke test created one mailbox; for a real send
you typically want your own. Mailbox CRUD lives in the admin REST
surface — for this tutorial we reuse the synthetic mailbox the smoke
test landed on, or you can create one through the panel later.

```sh
polaris-mail cred issue \
  --mailbox <mailbox-id> \
  --type http \
  --senders 'noreply@<your-domain>'
```

The plaintext secret is printed **exactly once**. Pipe to your
secret store:

```sh
polaris-mail cred issue ... -o json | jq -r .secret | op item create ...
```

## 11. Send a test message (2 min)

The HMAC signing scheme is identical for all three transports — only
the surface differs. Pick one.

### curl

```sh
TS=$(date +%s)000
NONCE=$(openssl rand -hex 12)
BODY='{"from":"noreply@example.com","to":["you@external.com"],"subject":"hello","text":"hi from polaris-mail","category":"test"}'
BH=$(printf "%s" "$BODY" | openssl dgst -sha256 -hex | awk '{print $2}')
CANON="polaris-api\nPOST\n/v1/messages\n\n$TS\n$NONCE\n$BH"
SIG=$(printf "%b" "$CANON" | openssl dgst -sha256 -hmac "$POLARIS_MAIL_KEY_SECRET" -hex | awk '{print $2}')
curl -sS -X POST "$POLARIS_MAIL_URL/v1/messages" \
  -H "content-type: application/json" \
  -H "x-polaris-key-id: $POLARIS_MAIL_KEY_ID" \
  -H "x-polaris-ts: $TS" -H "x-polaris-nonce: $NONCE" -H "x-polaris-sig: $SIG" \
  -d "$BODY"
```

### Node SDK

```ts
import { PolarisMailClient } from '@polaris/sdk';

const client = new PolarisMailClient({
  baseUrl: process.env.POLARIS_MAIL_URL!,
  keyId: process.env.POLARIS_MAIL_KEY_ID!,
  keySecret: process.env.POLARIS_MAIL_KEY_SECRET!,
});

await client.messages.send({
  from: 'noreply@example.com',
  to: ['you@external.com'],
  subject: 'hello',
  text: 'hi from polaris-mail',
  category: 'test',
});
```

### Go SDK

```go
import polaris "github.com/vladzaharia/polaris-email/packages/sdk-go"

c := polaris.NewClient(polaris.Config{
    BaseURL:   os.Getenv("POLARIS_MAIL_URL"),
    KeyID:     os.Getenv("POLARIS_MAIL_KEY_ID"),
    KeySecret: os.Getenv("POLARIS_MAIL_KEY_SECRET"),
})
_, err := c.Messages.Send(ctx, &polaris.SendRequest{
    From:     "noreply@example.com",
    To:       []string{"you@external.com"},
    Subject:  "hello",
    Text:     "hi from polaris-mail",
    Category: "test",
})
```

Expect `202 Accepted` with `{ "messageId": "01HXR...", "queuedAt": ..., "mode": "live" }`.
A `4xx` or `5xx` lands in the [error catalog](/reference/errors); the
[troubleshooting decision matrix](/operators/troubleshooting/decision-matrix)
walks the common ones.

## 12. See it in the panel (instant)

If you wired OIDC in step 2:

```
https://<your-panel-host>/panel/messages
```

The row is the `messageId` you just got back. Click through for the
unified [Message model](/developers/messages/unified-model) view —
status timeline, webhook delivery attempts, R2-backed body and
attachments, audit chain references.

If you didn't wire OIDC, the same data is reachable via
`GET /v1/messages/{id}` over the REST API; the
[developer quickstart](/developers/quickstart) has the recipe.

## Next steps

You have a working control plane and one credential. To go from
"single test send" to "this thing is in production":

- **Onboard a sending domain** — DKIM, SPF, DMARC, MX. Single command:
  `polaris-mail domain onboard <domain> --inbound --outbound`. See the
  [domain onboarding runbook](/operators/runbooks).
- **Stand up the on-prem mail bridge** if you need SMTPS / IMAP for
  human-facing mailboxes. Two deployment modes —
  [see the bridge concept page](/operators/concepts/mail-bridge).
- **Subscribe a webhook consumer**. The full Message is inlined in
  the v2 envelope; verifier code lives in the
  [developer quickstart](/developers/quickstart).
- **Wire monitoring + alerting**. The
  [monitoring page](/operators/day-2/monitoring) covers the SLOs you
  should aim for and how `ALERT_WEBHOOK` fans into Slack / PagerDuty.
- **Lock down the panel with Cloudflare Access**. The
  [Cloudflare Access walkthrough](/operators/deployment/cloudflare-access)
  covers OIDC IdPs, group-based role sync, and step-up policies.

<!-- Verified against: apps/polaris-cli/README.md, apps/polaris-cli/internal/setup/cmd/{infra_apply,infra_configure,infra_deploy,infra_migrate,infra_plan,infra_preflight,infra_render,infra_secrets,infra_smoke}.go, apps/docs/content/developers/quickstart.md, apps/docs/content/security/threat-model.md @ eeee222cdf8359f8f2bf1013a103abdb3c705f06 -->
