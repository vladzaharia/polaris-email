# Changelog

This file tracks notable architectural changes. For operator-visible
behavior, see [`CONSUMER-CONTRACT.md`](CONSUMER-CONTRACT.md); for cutover
runbooks, see [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Unreleased — final architecture cutover

Hard cutover; no overlap window. Everything below ships together.

### Wire format

- **Webhook envelope v1 → v2 (hard cutover).** The webhook body is now
  `{event_id, event, occurred_at, message}` with the full `Message`
  inlined; consumers no longer need a follow-up `GET /v1/messages/:id`.
  Signed with `X-Polaris-Sig: v2=…`. The HMAC canonical-string format and
  the `polaris-webhook.v1` HMAC domain tag are unchanged; only the
  envelope shape and the signature header tag changed. There is no v1
  fallback.
- **API direction unchanged.** Outbound API requests continue to sign with
  `X-Polaris-Sig: v1=…` over the `polaris-api.v1` domain tag.

### Data model

- **Mailbox-centric schema (drops tenants).** `0001_init.sql` is the
  canonical from-scratch shape. Operators own N mailboxes; each mailbox
  owns its senders (`mailbox_senders`), receivers (`mailbox_receivers`),
  principals (API keys / SMTP creds), and webhook subscriptions. Every
  message has exactly one `mailbox_id`. The previous tenants /
  email_senders layout was rolled back wholesale.

### Endpoints

- **`POST /v1/messages` accepts both `application/json` (SendRequest) and
  `message/rfc822` (raw MIME).** `/v1/send/raw` is retired.
- **New retrieval surface**: `GET /v1/messages`, `GET /v1/messages/:id`,
  `POST /v1/messages/get` (bulk), `GET /v1/mailboxes/:id/changes` (delta
  cursor), `GET /v1/mailboxes/:id/messages?fields=metadata`,
  `GET /v1/messages/:id/attachments/:n` (URL self-signs).
- **State mutations**: `PATCH /v1/messages/:id`, `DELETE /v1/messages/:id`,
  `POST /v1/mailboxes/:id/expunge`. These do **not** emit webhooks (the
  consumer is the one driving the change).
- **Unified `Message` shape** across inbound + outbound. Bodies inline
  below `MESSAGE_BODY_INLINE_MAX` (default 64 KiB); larger bodies and
  attachments surface as short-lived signed R2 URLs
  (`SIGNED_URL_TTL_SECONDS`, default 600 s). R2 keys are content-addressed
  with `r2_refs` reference counting.

### SDKs

- **First-party SDKs in three languages**, generated from a single OpenAPI
  spec by `packages/sdk-codegen/`:
  - `@polaris/sdk` (Node/TS) with `/core`, `/react` (TanStack Query
    hooks), `/node`, and `/webhook` sub-paths.
  - `polaris-sdk` (Python, httpx + Pydantic v2).
  - `polaris-sdk-go` (Go).
- Hand-written webhook verifiers preserved in each SDK
  (`packages/sdk-{node,python,go}`), listed in
  `packages/sdk-codegen/preserve.json`; CI regen-diff blocks drift.
- **Replaces** the per-language `packages/webhook-verify-{node,go,python}`
  packages, which are gone.
- Full SDK regen requires Java 17+ and a Go 1.22+ toolchain on `$PATH`;
  language-scoped regen targets are also available.

### Pipeline

- **Unified `processMessage`** in `packages/pipeline` is the single code
  path for inbound (`services/in`) and outbound (`services/api`) mail.
  Validation, address normalisation, attachment limits, and audit
  semantics no longer have two implementations to drift.

### On-prem mail bridge

- **`apps/submission-daemon` → `apps/mail-bridge`.** The renamed
  application consolidates SMTPS submission (:465), IMAP4rev2 retrieval
  (:993), and JMAP (:443) into a single Go binary.
- **Two equally-supported deployment modes** (neither is "the default"):
  - **Tailnet-fronted** via `tailscale/tailscale` sidecar + MagicDNS +
    `tsnet.ListenTLS` (Lego ACME-DNS-01 fallback). Compose:
    `apps/mail-bridge/docker-compose.tailscale.yml`.
  - **Local / host-network** — bridge binds 465/993/443 directly; operator
    owns firewall + TLS. Compose: `apps/mail-bridge/docker-compose.local.yml`.

### Services

- **`services/forensic` removed.** The recipient AEAD key escrow path is
  deleted. Recipients are unrecoverable post-submission by design;
  consumers anticipating subpoena response keep their own outbound logs.
  `FORENSIC_MASTER_KEY` is no longer minted at bootstrap.
- **`services/api` hosts `REVOCATION_DO`** (Durable Object) for synchronous
  ≤5 s credential revocation. The optional EMAIL binding on services that
  do not actually send was dropped.

### Tooling / lint

- **`oxlint` + `oxfmt` rollout.** Replaces the previous Biome /
  ESLint / Prettier triad; root scripts: `pnpm lint`, `pnpm fmt:check`.
  `.oxlintrc.json` + `.oxfmtrc.json` at repo root; lefthook wires both
  into the pre-commit hook.

### Panel

- **`apps/panel`** ships as a Cloudflare Worker with better-auth + OIDC
  (Cloudflare Access as the default IdP); sessions in D1. The previous
  WebAuthn-step-up dev stub is replaced.
