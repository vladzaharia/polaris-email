# polaris-email — threat model

## Trust boundaries

1. **Public internet → Cloudflare Email Routing inbound** — adversary delivers crafted MIME. Mitigated by: raw-bytes-to-R2 before parse, hard CPU/recursion/attachment-size limits in `polaris-email-in`, sender allowlist per mailbox, regex ReDoS guards.

2. **Tailnet → bridge listeners (465/993/443)** — adversary already on the Tailnet. Mitigated by: ACL tags (`tag:mail-clients` per service, granular per-mailbox), Mox SASL lockout, implicit-TLS only on 465.

3. **Consumer-held API keys → polaris-email-api** — adversary holds one leaked key. Mitigated by: per-key HMAC secrets (rotation is per-key), `sender_scopes` restricts `from` addresses, rate limits per-key, emergency revoke with ≤5 s propagation, `api_key_usage` log records every IP/UA/Ray.

4. **Panel session (OIDC + WebAuthn step-up) → admin endpoints** — adversary has a stolen panel session. Mitigated by: OIDC group gating (`polaris-admins`), step-up auth for destructive ops (DKIM rotation, forensic decrypt, mass revoke), 2-person rule for forensic decrypt, every mutation audited with hash chain.

5. **Bridge container internal** — adversary RCEs Mox or the sidecar. Mitigated by: Mox runs in its own netns (cannot speak as the Tailnet identity), `cap_drop: [ALL]`, `read_only: true`, per-mailbox bridge keys (Mox RCE compromises only mailboxes that ever submitted through it), WebAPI over unix socket not TCP.

6. **`polaris-email-out` CF account vs control-plane CF account** — `send_email` bindings are CF-account-scoped. Mitigated by: deploy `polaris-email-out` in a dedicated CF account that holds no other Workers and no other API tokens, invoked from `polaris-email-api` only via a Service Binding.

7. **Forensic Worker** — isolated Worker that holds the recipient AEAD master key. Mitigated by: separate Worker (not in the api Worker's blast radius), HKDF-per-row keys, requires `incident_ticket_id` + two distinct OIDC subjects to decrypt, every decrypt audited.

## In-scope adversaries

- Malicious external sender (MIME bombs, header smuggling, bounce spoofing).
- Compromised internal service holding one API key.
- Compromised webhook consumer (receiver-side replay).
- Curious Tailnet user (not in `tag:mail-clients`).
- Stolen developer laptop with `wrangler` configured against the panel account.
- Supply-chain compromise of a pinned image (mitigated by digest pinning; bumps reviewed in CI).

## Out of scope

- **Fully compromised Cloudflare root API token** — mitigated by Logpush mirror + kill-switch runbook, not prevented.
- **Fully compromised Tailscale ACL admin** — we accept this; the bridge's exposure surface is fully gated on ACL tags.

## Cryptographic notes

- **HMAC** SHA-256, 256-bit keys, domain-separated (`polaris-api.v1` / `polaris-webhook.v1`), canonical-string includes method+path+query+ts+nonce+body-hash. Constant-time compare. `v1=` allowlist refuses downgrade.
- **Forensic AEAD** AES-GCM with HKDF-per-row key derivation from a 256-bit master. Master held in `wrangler secret` for the *forensic* Worker only.
- **Audit chain** SHA-256 prev_hash linking, hourly anchor signed and pushed to R2 under Object Lock. Anchor signing key is held separately.
- **Argon2id parameters** OWASP 2024 minimums; declared in `services/api/src/hashing.ts`. (PBKDF2-SHA256 i=600000 substitute for Workers; upgrades by adding a new prefix in the PHC string and rehashing on read.)
- **bcrypt cost 12** for Mox mailbox passwords (Mox is the consumer; sidecar bcrypts at issue time).

## Gating

- **First non-synthetic consumer** requires: HMAC test vectors green in all 3 verifier libs, audit hash-chain verified, R2 Object Lock active in compliance mode, end-to-end synthetic green for 7 days, external pentest report archived under `SECURITY/pentests/`.
- **GA** requires every High-severity item in the design plan closed; D1 PITR drill executed; CF-account-compromise kill switch drill executed in a sandbox.

See `RUNBOOKS/` for procedures.
