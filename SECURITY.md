# polaris-email — threat model

## Trust boundaries

1. **Public internet → Cloudflare Email Routing inbound** — adversary delivers crafted
   MIME. Mitigated by: raw-bytes-to-R2 before parse, hard CPU/recursion/attachment-size
   limits in `services/in`, sender allowlist per mailbox, regex ReDoS guards.

2. **Mail bridge host → bridge listeners (:465 / :993 / :443)** — adversary on the
   host network attempts to relay or steal credentials. Mitigated by: implicit TLS
   only (no STARTTLS) on SMTPS, per-bridge `BRIDGE_ID` + HMAC key, SQLite credential
   mirror polled from the control plane behind a Cloudflare Access service-token,
   TLS cert hot-reload so renewals do not require a restart, audit log of every
   authenticated session. Two deployment modes are supported equally: tailnet-fronted
   (Tailscale sidecar) and local / host-network (operator-managed TLS).

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

5. **`services/out` CF account vs control-plane CF account** — `send_email`
   bindings are CF-account-scoped. Mitigated by: deploy `services/out` in a
   dedicated CF account that holds no other Workers and no other API tokens,
   invoked from `services/api` only via a Service Binding.

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
  kill-switch runbook (`RUNBOOKS/cf-account-compromise.md`), not prevented.
- **Recipient recovery after submission** — by design, plaintext recipients are
  not retained server-side; see [`CONSUMER-CONTRACT.md`](CONSUMER-CONTRACT.md).

## Cryptographic notes

- **HMAC** SHA-256, 256-bit keys, domain-separated (`polaris-api.v1` /
  `polaris-webhook.v1`), canonical-string includes method+path+query+ts+nonce+body-hash.
  Constant-time compare. The signature header tag is `v1=` for API requests and
  `v2=` for webhook deliveries (the v2 envelope inlines the full `Message`; the
  HMAC scheme itself is unchanged).
- **Audit chain** SHA-256 prev_hash linking, hourly anchor signed and pushed to R2 under
  Object Lock. Anchor signing key is held separately in the `polaris-anchors`
  Cloudflare account.
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
- [ ] R2 Object Lock active in compliance mode on both `polaris-email` and the
      anchors bucket; verified via `wrangler r2 bucket info`.
- [ ] End-to-end synthetic green for 7 consecutive days.
- [ ] External pentest report archived under `SECURITY/pentests/`.
- [ ] Retention janitor (cron) drill: schedule a fake retention bucket, confirm
      `r2_refs` decrements and the underlying object is deleted only when refs
      reach zero.

## GA gating

GA additionally requires: D1 PITR drill executed; CF-account-compromise kill switch
drill executed in a sandbox; documented runbook for every alert in
`docs/RUNBOOK.md`.

See `RUNBOOKS/` and `docs/RUNBOOK.md` for procedures.
