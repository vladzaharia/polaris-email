---
title: Threat model
description: Trust boundaries, in-scope adversaries, and the mitigations that back each one — the canonical security posture for polaris-mail.
sidebar_label: Threat model
sidebar_position: 2
---

# polaris-mail — threat model

:::info Source
This page mirrors `SECURITY.md` at the repo root. The file under
`apps/docs/content/security/threat-model.md` is the operator-facing
rendering; edit `SECURITY.md` first and re-sync.
:::

## Trust boundaries

1. **Public internet → Cloudflare Email Routing inbound** — adversary
   delivers crafted MIME. Mitigated by: raw-bytes-to-R2 before parse,
   hard CPU/recursion/attachment-size limits in `services/in`, sender
   allowlist per mailbox, regex ReDoS guards.

2. **Mail bridge host → bridge listeners (:465 / :993)** — adversary on
   the host network attempts to relay or steal credentials. Mitigated
   by: implicit TLS only (no STARTTLS) on SMTPS, per-bridge `BRIDGE_ID`
   paired with per-bridge HMAC key, SQLite credential mirror polled from
   the control plane behind a Cloudflare Access service-token,
   bcrypt-only client auth on both ports (no bearer tokens — JMAP and
   its bearer-token model were deleted), TLS cert hot-reload so renewals
   do not require a restart, audit log of every authenticated session.
   Two deployment modes are supported equally: tailnet-fronted
   (Tailscale sidecar) and local / host-network (operator-managed TLS).

3. **Consumer-held API keys → services/api** — adversary holds one
   leaked key. Mitigated by: per-key HMAC secrets (rotation is per-key),
   `sender_scopes` restricts `from` addresses, rate limits per-key,
   emergency revoke with ≤60 s propagation via the KV-backed
   `revocationCheck` (`KV_REVOCATIONS` namespace + 60 s per-Worker
   cache), `api_key_usage` log records every IP/UA/Ray.

4. **Panel session → admin endpoints** — adversary has a stolen panel
   session. Mitigated by: better-auth with OIDC group gating
   (`polaris-admins`, default IdP is Cloudflare Access), client-side
   `DestructiveActionDialog` confirmation (the operator must type the
   resource name) on every destructive op (DKIM rotation, mass revoke,
   bridge deregister, mailbox-credential rotate, webhook secret rotate),
   and every mutation audited via the chained-hash `audit_log` table.
   Each row's `row_hash` is `SHA-256(prev_hash || canonical row)` so any
   out-of-band rewrite breaks the chain; the `audit-verify` cron walks
   the chain end-to-end nightly. Sessions are stored in D1. The earlier
   two-person `withApproval` flow was removed — real deployments are
   single-operator and the second-admin co-sign step was unusable;
   type-the-name + audit-log replace it. The OIDC `groups` claim is
   capped at 200 entries so a hostile or misconfigured IdP can't DoS the
   sign-in path with a megabyte-sized array.

5. **`services/out` ↔ `services/api`** — `send_email` bindings are
   CF-account-scoped. `services/out` is invoked from `services/api` only
   via a Service Binding (not a public fetch), so a stolen API key cannot
   directly invoke the outbound provider.

## In-scope adversaries

- Malicious external sender (MIME bombs, header smuggling, bounce
  spoofing).
- Compromised internal service holding one API key.
- Compromised webhook consumer (receiver-side replay).
- Compromised mail-bridge host (single-host blast radius, scoped to one
  `BRIDGE_ID`'s credentials).
- Stolen developer laptop with `wrangler` configured against the panel
  account.
- Supply-chain compromise of a pinned image (mitigated by digest
  pinning; bumps reviewed in CI).

## Out of scope

- **Fully compromised Cloudflare root API token** — mitigated by Logpush
  mirror + kill-switch runbook
  ([cf-account-compromise](/operators/runbooks/cf-account-compromise)),
  not prevented. The audit-chain hash inside D1 detects in-band
  rewrites, but a root-level CF compromise can wipe the chain itself;
  D1 Time-Travel is the recovery surface (point-in-time restore covers
  ~30 days), paired with the weekly D1 export to R2 under `backups/d1/`
  (12-week retention) for longer-horizon recovery.
- **Recipient recovery after submission** — by design, plaintext
  recipients are not retained server-side; see
  [consumer contract](/reference/consumer-contract).

## R2 public custom domain

Message bodies and per-attachment R2 objects are served from the public
custom domain `r2.mail.plrs.im`. Object keys are content-addressed
(`mime/<aa>/<bb>/<sha256>` for bodies, `att/<sha256>/<filename>` for
attachments), so the SHA-256 in the URL provides the unguessability
boundary — there is no signature, no expiry, no HMAC header.

**Privacy implication**: a polaris-mail URL **is** a capability token.
Anyone with the URL can read the bytes forever. Because the audit log
records the content SHA-256 of every message, an audit-log reader gains
implicit read access to every message body and attachment. This is
acceptable at the internal-deployment scale polaris-mail targets
(&lt;10k msg/day, ~tens of mailboxes, a handful of admins who already
have admin-level mailbox access). External or compliance-bound
deployments would need a different model — either re-introduce signed
URLs in front of R2 or move bodies behind an authenticated proxy.

## Cloudflare API token scope (CF_API_TOKEN)

The control plane stores a single `CF_API_TOKEN` secret in
`services/api`'s Worker secrets. It is used by:

- The DKIM rotation cron (DNS record edits + Email Service
  `/sender-domains`).
- The new **CF zone discover + configure** flow
  (`services/api/src/routes/admin/cf-zones.ts`), which lists every zone
  in the operator's account and inspects each one's Email Routing +
  sender state. Apply path enables Email Routing, sets the catch-all to
  `polaris-mail-in`, onboards the sender domain, and creates the D1
  `mail_domains` row.

Required scopes (broader than the original "Email Routing on a specific
zone" model — the discover view needs to enumerate all zones):

- Account → **Email Routing** → Edit
- Account → **Workers Email Sending** → Edit
- Account → **Zone** → Read (account-wide)
- Zone → Zone → Edit
- Zone → DNS → Edit

The token is **per-account**. Use a dedicated CF account for
polaris-mail so the token's blast radius is confined to that account's
zones. Rotation: mint a new token, push via
`wrangler secret put CF_API_TOKEN` on `polaris-mail-api`, then revoke
the old token in the Cloudflare dashboard. The CF zone configure path
is idempotent so a brief inflight window with both tokens valid is
safe.

Note that polaris-mail **never modifies operator-defined named-address
routing rules**. The discover view surfaces them as warnings (e.g. "3
named rules will intercept mail before reaching polaris-mail-in") but
the configure flow never deletes them — those rules belong to the
operator.

## Bridge cross-mailbox read (v1 scope)

Mail bridges authenticate to the control plane with a **per-bridge HMAC
key** (the global `BRIDGE_HMAC_KEY` was retired in pre-launch hardening
so that a single leaked key no longer compromises every bridge). The
per-bridge key still grants **cross-mailbox read** within the
deployment: a bridge can fetch credentials and message state for any
mailbox it serves.

This is intentional v1 scope. The bridge is the IMAP / SMTPS client
surface for every mailbox-credential it mirrors, so it must be able to
look those up by username on demand. Narrowing the scope to per-mailbox
would require either a per-mailbox bridge identity (operationally
painful) or an authenticated mailbox-claim handshake (deferred). v1.1
will narrow this: the bridge will present the resolving
mailbox-credential's bcrypt hash as proof-of-possession before getting
back any non-credential mailbox state.

Per-bridge HMAC isolation prevents the **global-key blast radius**
failure mode (one leaked key everywhere); the v1 trust model accepts
the residual cross-mailbox-read inside one bridge.

## `DEV_MODE` operator gate

`DEV_MODE` is a local-development-only flag. It must **never** be set
in production. The panel's `/api/dev/login` backdoor short-circuits
OIDC and hands out a session for any local user; the route is
**fail-closed when `ENVIRONMENT=production`** (added in pre-launch
hardening, phase 3e) — the endpoint refuses to serve and logs an error
regardless of `DEV_MODE`.

The two values are checked together: `ENVIRONMENT=production` OR
`DEV_MODE` unset → backdoor refuses. To run the panel locally with the
dev login enabled: `DEV_MODE=1` and leave `ENVIRONMENT` unset (or set
it to `development`).

## Read-once secrets (A11/B6)

Every secret polaris-mail issues — API key secrets, SMTPS / IMAP
passwords, bridge HMAC keys — is shown to the operator **exactly
once**: at creation or rotation. The control-plane database stores
hashes only (bcrypt for mailbox passwords; HMAC-key hashes for bridges;
secret-cache keyed by `key_id → hash` for API keys). There are no
plaintext columns on `principals`, `mailbox_credentials`, or `bridges`.
To "view" a secret that was already issued, the operator rotates it —
which mints a new value and shows that one once.

The `/v1/admin/*` issuance and rotation endpoints return the plaintext
exactly once in the response body, never written to logs, never echoed
in audit rows. The panel surfaces this via `SecretRevealDialog`
(`apps/panel/src/components/SecretRevealDialog.tsx`) — a single modal
the operator must copy out of before dismissing.

## Audit chain integrity

Each `audit_log` row's `row_hash` is
`SHA-256(prev_hash || canonical(row))`. A continuous chain that hashes
to the latest head is the in-band tamper signal — any out-of-band
rewrite of an older row invalidates every later `row_hash`, and the
`audit-verify` cron walks the chain end-to-end nightly
(`services/api/src/scheduled/audit-verify.ts`). A break records a
`status='error'` row in `cron_runs` and the panel diagnostics card
turns red.

The chain defends against accidental / sloppy direct-DB-write
rewrites; it does **not** defend against an adversary who fully owns
the Cloudflare account (they can recompute the chain). For defence
against a CF-root compromise, the recovery surface is **D1 Time-Travel**
(point-in-time restore covers ~30 days) plus the weekly D1 export to
R2 (operator-owned `backups/d1/` prefix, 12-week retention).

## Cryptographic notes

- **HMAC** SHA-256, 256-bit keys, **un-versioned** and domain-separated
  (`polaris-api` for HTTP requests, `polaris-webhook` for outgoing
  webhook deliveries — no `.v1` suffix). Canonical-string is
  `direction\nmethod\npath\ncanonical-query\nts\nnonce\nsha256-hex-of-body`.
  Signature header is `X-Polaris-Sig: <lowercase-hex>` — no `v1=` /
  `v2=` prefix. Constant-time compare. Full spec:
  [HMAC reference](/security/hmac-reference).
- **Audit chain** SHA-256 `prev_hash` linking inside `audit_log` —
  walked end-to-end nightly by the `audit-verify` cron. See the
  "Audit chain integrity" section above for the threat model.
- **Argon2id parameters** OWASP 2024 minimums; declared in
  `packages/crypto-utils`. PBKDF2-SHA256 i=600000 is the
  Workers-runtime substitute; upgrades land by adding a new PHC prefix
  and rehashing on read.

## Gating checklist for first non-synthetic consumer

- HMAC test vectors (`packages/test-vectors/vectors.json`) green in
  both SDK webhook verifiers (`@polaris/sdk/webhook`, `polaris-sdk-go`).
- Audit hash-chain verified end-to-end with
  `polaris-mail audit verify`; `audit-verify` cron writes
  `status='ok'` to `cron_runs` on its nightly run.
- `revocationCheck` drill: revoke a test key, confirm next
  authenticated request returns `key_revoked` within ≤60 s (KV
  propagation + cache TTL).
- R2 Object Lock active in compliance mode on the `polaris-mail`
  bucket (bodies + attachments); verified via `wrangler r2 bucket info`.
- D1 Time-Travel drill: pick a recent bookmark, restore into a copy
  DB, verify a known operator action lands at the expected row.
- End-to-end synthetic green for 7 consecutive days.
- External pentest report archived under `SECURITY/pentests/`.
- Retention janitor (cron) drill: schedule a fake retention bucket,
  confirm `r2_refs` decrements and the underlying object is deleted
  only when refs reach zero.

## GA gating

GA additionally requires: D1 PITR drill executed; CF-account-compromise
kill switch drill executed in a sandbox; documented runbook for every
alert in the [operator runbooks](/operators/runbooks/overview).
