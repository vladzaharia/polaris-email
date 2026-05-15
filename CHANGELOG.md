# Changelog

This file tracks notable architectural changes. For operator-visible
behavior, see [`CONSUMER-CONTRACT.md`](CONSUMER-CONTRACT.md); for cutover
runbooks, see [`docs/deploy.md`](docs/deploy.md).

## 2026-05-14 — Cleanup plan implementation (Phases M, N, O)

Comprehensive cleanup driven by a 16-specialist code review. ~290 files
changed; net -3380 LOC.

### Critical security fixes

- **F1 revocation silent fail-open repaired (A1)** — `services/api` was
  hitting a Durable Object route that didn't exist; 404 collapsed to
  "not revoked". The DO was deleted entirely and replaced with a
  KV-backed `revocationCheck` (`KV_REVOCATIONS` namespace + ≤60s
  propagation, per-Worker 60s cache); revoke now writes both
  `KV_REVOCATIONS` and busts `KV_KEY_CACHE` in one call.
- **O0 anchor R2 public-leak fixed (B5 regression)** — audit anchors had
  been writable to the public-domain bucket; moved to a private R2
  bucket. Superseded by O1 below, which routes anchors to Backblaze B2
  with Object Lock COMPLIANCE.
- SMTPS forwarder `Idempotency-Key` (A2), OIDC role-sync on every
  sign-in (A3), webhook → push → mirror race repaired (A4), bcrypt cost
  normalized to 12 across issuance + dummy-burn (A5), SSRF allowlist
  hardened with RFC 1918 + CGNAT + DNS pinning (A6), audit chain
  wrapped in D1 transaction (A7), idempotency PK promoted to composite
  `(principal_id, key)` (A8), sdk-go unsafe `VerifyWebhook` overload
  deleted in favor of the strict verifier (A9), read-once secrets
  enforced end-to-end (A11/B6).

### Architecture restructure

- **5 Workers → 3 (B1)** — `services/api` absorbed `services/fanout`
  (webhook queue consumer) and `services/cron` (hourly anchor + nightly
  janitor + per-minute health + weekly staleness). `services/in` and
  `services/out` remain separate because they have distinct trust
  surfaces (Email Routing handler / outbound provider binding).
- **3 CF accounts → 1 (O1)** — `polaris-anchors` and `polaris-staging`
  collapsed into `polaris-prod`. Tamper-evidence now anchored externally
  via **Backblaze B2 with Object Lock COMPLIANCE** (~7-year retention);
  B2 application key scoped write-only; B2 credentials live in the
  operator's password vault, not in the Cloudflare account.
- **HMAC un-versioned (B3)** — domain tags `polaris-api` /
  `polaris-webhook` (no `.v1` suffix); signature header
  `X-Polaris-Sig: <hex>` (no `v1=` / `v2=` prefix). Single webhook
  envelope (v2). Hard cutover; no parallel-accept.
- **`daemon` → `bridge` terminology (B4)** — schema columns
  (`bridges` table), env vars (`BRIDGE_*`), CLI subcommand
  (`polaris-email bridge ...`), and code references all renamed.
- **R2 public custom domain `r2.mail.plrs.im` (B5)** — message bodies
  and attachments served via content-addressed URLs (SHA-256 keys are
  the unguessability boundary); replaces the previous signed-URL
  expiry model. `polaris-email` bucket stays under Object Lock for
  retention. Privacy implication (URL = capability) documented in
  `SECURITY.md`.
- **JMAP deleted (C1)** — ~1400 LOC removed (capabilities, methods,
  WebSocket, EventSource, blob endpoints, bearer-token model). Bridge
  is now SMTPS + IMAP only; `mailbox_credentials.bearer_token` column
  dropped.
- **IMAP migration to `emersion/go-imap` v2 (O2)** — **pending**; this
  cleanup wave kept the hand-rolled handler in tree. The on-the-wire
  protocol does not change. Tracked separately.
- **Read-once secrets schema (A11/B6)** — no plaintext columns on
  `principals`, `mailbox_credentials`, or `bridges`; secrets shown
  exactly once at creation/rotation; panel `SecretRevealDialog`
  enforces the single-reveal UX.

### Cleanup

- **~10 dead artifacts deleted (D1)**: `services/forensic` (empty
  scaffold), `packages/webhook-verify-{node,python}` (replaced by
  SDK-embedded verifiers), `packages/migrations` (unused),
  `packages/sdk-python` (zero internal consumers), `packages/sdk-codegen`
  (never produced anything real), `bin/drill-restore.sh`,
  `apps/panel/src/components/ApproverPicker.tsx`, the entire
  `tenant` CLI subcommand, the L-phase spike (archived), the Java +
  Python jobs in `.github/workflows/ci.yml`.
- **HMAC dedup (D2)**: three implementations (`packages/hmac`,
  `bin/_lib.sh`, in-SDK) collapsed to one in `packages/hmac`; the
  new `polaris-email auth sign` / `polaris-email auth verify` CLI
  replaces shell-level `polaris_sign`.
- **MIME promotion (D3)**: `services/in/parse.ts` moved to
  `packages/mime/headers.ts` so `services/api` (REST RFC822 submit)
  and `services/in` (Email Routing) share one parser (270 LOC).
- **`tenantId` → `mailboxId` rename (D4)** across schema, code, SDKs,
  and panel.

### Panel polish

- `DestructiveActionDialog` (E1) wraps 10 destructive actions with a
  typed-confirm modal; `SecretRevealDialog` (E2) handles read-once
  secret reveal.
- `StepUpModal` removed (E3 — was a placeholder); `sonner` toast
  notifications wired across all mutations (E4); `/diagnostics` page
  surfacing live system health (E5); breadcrumbs (E7); shared
  `status-badge` helper (E8); 4 new entity-creation forms (E9);
  TanStack Query key factories (E10); typed `ApiError` discrimination
  (E11); lazy-loaded routes with per-route `errorComponent` +
  4xx-no-retry policy (E12).
- Native `<select>` replaced with Radix `<Select>` across 11 callsites
  (E6).

### SDKs

- Typed `PolarisError` (TS) + `*APIError` (Go) hierarchies (G1).
- Test vectors regenerated for un-versioned HMAC; CI parity job covers
  both verifiers (G3).
- `sdk-go` `Message` struct aligned with OpenAPI (G4).
- `sdk-codegen` deleted; SDKs are hand-written from the
  `openapi/polaris-email.yaml` contract (G2). See `docs/sdk.md`.

### Docs

- Doc reorg (F7): `RUNBOOKS/` → `docs/runbooks/`; mid-tree docs
  lowercased (`docs/runbook.md`, `docs/operator.md`, `docs/deploy.md`).
- Phantom CLI commands removed across the renamed runbook + operator
  guide + cost-model; webhook event names corrected.
- `docs/hmac-reference.md` rewritten for un-versioned HMAC (F8); worked
  example pulled verbatim from `packages/test-vectors/vectors.json`.
- `docs/architecture.md` surgical edits (F9) — Workers table, Webhook
  fan-out, Storage, Audit chain, Authentication, CF account topology.
- `SECURITY.md` final pass (F10): read-once secrets section, Backblaze
  B2 anchor target section, HMAC un-versioning note, R2 public-URL
  capability semantics.
- New: `apps/panel/README.md`, `docs/cli.md` (revoke vs deregister vs
  disable vs delete vocabulary).

Commits: `71f6e41` (Phase M), `34aa9e0` (Phase N), `c17d490` (Phase O0);
Phase O1 + O3 in the next commit; Phase O2 (IMAP migration) tracked
separately.

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
  application consolidates SMTPS submission (:465) and IMAP4rev2 retrieval
  (:993) into a single Go binary.
- **Two equally-supported deployment modes** (neither is "the default"):
  - **Tailnet-fronted** via `tailscale/tailscale` sidecar + MagicDNS +
    `tsnet.ListenTLS` (Lego ACME-DNS-01 fallback). Compose:
    `apps/mail-bridge/docker-compose.tailscale.yml`.
  - **Local / host-network** — bridge binds 465/993 directly; operator
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
