# polaris-email — threat model

## Trust boundaries

1. **Public internet → Cloudflare Email Routing inbound** — adversary delivers crafted
   MIME. Mitigated by: raw-bytes-to-R2 before parse, hard CPU/recursion/attachment-size
   limits in `services/in`, sender allowlist per mailbox, regex ReDoS guards.

2. **Mail bridge host → bridge listeners (:465 / :993)** — adversary on the
   host network attempts to relay or steal credentials. Mitigated by: implicit TLS
   only (no STARTTLS) on SMTPS, per-bridge `BRIDGE_ID` + HMAC key, SQLite credential
   mirror polled from the control plane behind a Cloudflare Access service-token,
   bcrypt-only client auth on both ports (no bearer tokens — JMAP and its
   bearer-token model were deleted in phase C1), TLS cert hot-reload so renewals
   do not require a restart, audit log of every authenticated session. Two
   deployment modes are supported equally: tailnet-fronted (Tailscale sidecar)
   and local / host-network (operator-managed TLS).

3. **Consumer-held API keys → services/api** — adversary holds one leaked key.
   Mitigated by: per-key HMAC secrets (rotation is per-key), `sender_scopes` restricts
   `from` addresses, rate limits per-key, emergency revoke with ≤60 s propagation
   via the KV-backed `revocationCheck` (`KV_REVOCATIONS` namespace + 60 s per-Worker
   cache), `api_key_usage` log records every IP/UA/Ray.

4. **Panel session → admin endpoints** — adversary has a stolen panel session.
   Mitigated by: better-auth with OIDC group gating (`polaris-admins`, default IdP
   is Cloudflare Access), step-up auth for destructive ops (DKIM rotation, mass
   revoke, anchor key rotation), every mutation audited with hash chain. Sessions
   are stored in D1.

5. **`services/out` ↔ `services/api`** — `send_email` bindings are
   CF-account-scoped. `services/out` is invoked from `services/api` only
   via a Service Binding (not a public fetch), so a stolen API key cannot
   directly invoke the outbound provider. Note: the previous multi-account
   topology that gave `services/out` its own Cloudflare account was
   collapsed in phase O1 — tamper-evidence is now anchored externally via
   Backblaze B2 (see the "Audit anchors" section below) rather than via
   account separation.

## In-scope adversaries

- Malicious external sender (MIME bombs, header smuggling, bounce spoofing).
- Compromised internal service holding one API key.
- Compromised webhook consumer (receiver-side replay).
- Compromised mail-bridge host (single-host blast radius, scoped to one
  `BRIDGE_ID`'s credentials).
- Stolen developer laptop with `wrangler` configured against the panel account.
- Supply-chain compromise of a pinned image (mitigated by digest pinning; bumps
  reviewed in CI).

## Out of scope

- **Fully compromised Cloudflare root API token** — mitigated by Logpush mirror +
  kill-switch runbook (`docs/runbooks/cf-account-compromise.md`), not prevented.
- **Recipient recovery after submission** — by design, plaintext recipients are
  not retained server-side; see [`CONSUMER-CONTRACT.md`](CONSUMER-CONTRACT.md).

## R2 public custom domain (B5)

Message bodies and per-attachment R2 objects are served from the public
custom domain `r2.mail.plrs.im`. Object keys are content-addressed
(`mime/<aa>/<bb>/<sha256>` for bodies, `att/<sha256>/<filename>` for
attachments), so the SHA-256 in the URL provides the unguessability
boundary — there is no signature, no expiry, no HMAC header.

**Privacy implication**: a polaris-email URL **is** a capability token.
Anyone with the URL can read the bytes forever. Because the audit log
records the content SHA-256 of every message, an audit-log reader gains
implicit read access to every message body and attachment. This is
acceptable at the internal-deployment scale polaris-email targets
(<10k msg/day, ~tens of mailboxes, a handful of admins who already have
admin-level mailbox access). External or compliance-bound deployments
would need a different model — either re-introduce signed URLs in front
of R2 or move bodies behind an authenticated proxy.

Audit anchors are **not** stored in R2 at all — they live in an external
Backblaze B2 bucket (see the "Audit anchors" section below). No
polaris-email R2 bucket carries audit material.

## Read-once secrets (A11/B6)

Every secret polaris-email issues — API key secrets, SMTPS / IMAP
passwords, bridge HMAC keys — is shown to the operator **exactly once**:
at creation or rotation. The control-plane database stores hashes only
(bcrypt for mailbox passwords; HMAC-key hashes for bridges; secret-cache
keyed by `key_id → hash` for API keys). There are no plaintext columns
on `principals`, `mailbox_credentials`, or `bridges`. To "view" a secret
that was already issued, the operator rotates it — which mints a new
value and shows that one once.

The `/v1/admin/*` issuance and rotation endpoints return the plaintext
exactly once in the response body, never written to logs, never echoed
in audit rows. The panel surfaces this via `SecretRevealDialog`
(`apps/panel/src/components/SecretRevealDialog.tsx`) — a single modal
the operator must copy out of before dismissing.

## Audit anchors (O1)

Tamper-evidence is anchored to **Backblaze B2** (external to Cloudflare):

- Hourly signed anchors are written to a B2 bucket with **Object Lock in
  COMPLIANCE mode** and ~7-year retention. COMPLIANCE mode means **no**
  identity — not the root account, not the B2 support team — can shorten
  the retention period or delete the object before it expires.
- The B2 application key used by `services/api` to write anchors is
  **scoped write-only** (`writeFiles`-only; no `listFiles`,
  `readFiles`, `deleteFiles`, or `bypassGovernance`). Even a fully
  compromised Cloudflare account that exfiltrates the key cannot rewrite
  or delete existing anchors.
- The B2 credentials are **NOT stored in the Cloudflare account**. They
  live in the operator's password vault and are seeded as wrangler
  secrets only at deploy time. A wrangler-level compromise can read the
  in-flight secret value but, because the key is write-only, cannot use
  it to rewrite history.

Net property: an adversary who fully owns the polaris-email Cloudflare
account can still **stop** anchors from being written (denial of
service) but cannot **rewrite** existing anchors. The audit chain in D1
diverging from the latest B2 anchor is the tamper-evidence signal — see
`bin/audit-verify.sh`.

## Cryptographic notes

- **HMAC** SHA-256, 256-bit keys, **un-versioned** (phase B3) and
  domain-separated (`polaris-api` for HTTP requests, `polaris-webhook`
  for outgoing webhook deliveries — no `.v1` suffix). Canonical-string
  is `direction\nmethod\npath\ncanonical-query\nts\nnonce\nsha256-hex-of-body`.
  Signature header is `X-Polaris-Sig: <lowercase-hex>` — no `v1=` / `v2=`
  prefix. Constant-time compare. Full spec:
  [`docs/hmac-reference.md`](docs/hmac-reference.md).
- **Audit chain** SHA-256 `prev_hash` linking; hourly anchor signed and
  pushed to **Backblaze B2** (Object Lock COMPLIANCE mode, ~7-year
  retention) — see the "Audit anchors" section above. Anchor signing
  key is held in the operator vault, not the Cloudflare account.
- **Argon2id parameters** OWASP 2024 minimums; declared in `packages/crypto-utils`.
  PBKDF2-SHA256 i=600000 is the Workers-runtime substitute; upgrades land by adding a
  new PHC prefix and rehashing on read.

## Gating checklist for first non-synthetic consumer

- [ ] HMAC test vectors (`packages/test-vectors/vectors.json`) green in both SDK
      webhook verifiers (`@polaris/sdk/webhook`, `polaris-sdk-go`).
- [ ] Audit hash-chain verified end-to-end with `bin/audit-verify.sh`; latest
      `audit_anchors` row matches the off-platform anchor mirror.
- [ ] `revocationCheck` drill: revoke a test key, confirm next authenticated request
      returns `key_revoked` within ≤60 s (KV propagation + cache TTL).
- [ ] R2 Object Lock active in compliance mode on the `polaris-email`
      bucket (bodies + attachments); verified via `wrangler r2 bucket info`.
- [ ] Backblaze B2 anchor bucket: Object Lock COMPLIANCE mode confirmed
      via the B2 console; write-only application-key scope verified by
      attempting `b2 ls` / `b2 rm` with the same key and seeing both
      denied.
- [ ] End-to-end synthetic green for 7 consecutive days.
- [ ] External pentest report archived under `SECURITY/pentests/`.
- [ ] Retention janitor (cron) drill: schedule a fake retention bucket, confirm
      `r2_refs` decrements and the underlying object is deleted only when refs
      reach zero.

## GA gating

GA additionally requires: D1 PITR drill executed; CF-account-compromise kill switch
drill executed in a sandbox; documented runbook for every alert in
`docs/runbook.md`.

See `docs/runbooks/` and `docs/runbook.md` for procedures.
