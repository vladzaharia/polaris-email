# polaris-email — consumer contract

This document binds your service to polaris-email. Read it before integrating.

## Stability

- **Wire format**: `polaris-api.v1` (API direction) and `polaris-webhook.v1` (webhook direction, signed with `X-Polaris-Sig: v2=…` because the envelope inlines the full `Message`). The HMAC scheme itself is unchanged.
- **Error envelope**: shape and code names are stable. New codes may be added; existing codes never change meaning.

## What you must do

- Sign every request per <https://docs.mail.plrs.im/security/hmac-reference>. Use one of the published verifier libraries on the receive side.
- Honour `Retry-After` and `retryable: true/false`. Never retry `bad_signature`, `scope_violation`, `key_revoked`, `nonce_replay`, `idempotency_conflict`, `domain_not_verified`, `recipient_rejected`.
- Treat `key_propagating` as transient — retry once after `Retry-After` (~2 s).
- Hold **both** primary and secondary key pairs during planned rotation. Either pair is valid for the 24 h grace.
- Verify `X-Polaris-Sig` on every inbound webhook with a constant-time compare and refuse anything outside your configured `allowed_algorithms`.
- Dedupe inbound webhooks by `X-Polaris-Event-Id` for 24 h.

## What we guarantee

- Idempotent sends on `Idempotency-Key` for 24 h. Same key + same body → original `messageId`. Same key + different body → `409 idempotency_conflict`.
- Emergency rotation invalidates the old credential within ≤5 s of the panel button click. Planned rotation gives 24 h.
- Zero-payload logging by default. **Recipients are unrecoverable post-submission**; the service does not retain plaintext recipient addresses past delivery. If you anticipate having to respond to subpoenas or otherwise reconstruct who you sent to, keep your own outbound logs on the consumer side — polaris-email cannot produce them after the fact.
- Webhook deliveries retry with exponential backoff up to 6 attempts, then DLQ. DLQ messages can be replayed from the panel.
- Audit chain is hash-linked and externally anchored. Tampering is detectable.
