---
title: For security reviewers
description: Threat model, the HMAC signing spec, R2 unguessability boundary, audit-chain integrity, credential revocation, and compliance posture.
sidebar_label: Overview
sidebar_position: 0
---

# Security documentation

The security posture, top to bottom.

## Start here

→ **[Threat model](/security/threat-model)** — trust boundaries,
in-scope adversaries, and the mitigations that back each one. Required
reading before changing anything that touches HMAC, R2 public URLs, or
the audit chain.

## Cryptography

→ **[HMAC reference](/security/hmac-reference)** — the formal
canonical-string spec, byte-by-byte. Two domain tags (`polaris-api`,
`polaris-webhook`), un-versioned bare-hex signature header, ±5-minute
clock skew, constant-time compare. Test vectors live at
`packages/test-vectors/vectors.json`.

The developer-facing narrative — "why HMAC, why a nonce" — is at the
[HMAC concept](/developers/authentication/concept) page.

## Email authentication

→ **[DKIM / DMARC / SPF](/security/dkim-dmarc-spf)** — what
polaris-email publishes per outbound domain, the default policy posture,
DKIM rotation, MTA-STS and TLS-RPT for inbound TLS hardening.

## Operational properties referenced by the threat model

- **Audit chain integrity is in-D1.** Each `audit_log` row's `row_hash`
  is `SHA-256(prev_hash || canonical(row))`; the `audit-verify` cron
  walks the chain end-to-end nightly. See the
  ["Audit chain integrity" section](/security/threat-model#audit-chain-integrity)
  of the threat model. For recovery after a CF-root compromise (which
  the chain alone cannot defend against), see
  [D1 point-in-time recovery](/operators/runbooks/d1-recovery) and
  [D1 backup hygiene](/operators/day-2/d1-backup).
- **Credential revocation is KV-backed, ≤60 s propagation.** See the
  [credential management page](/operators/day-2/credential-management).
- **Read-once secrets** — every secret polaris-email issues is shown
  exactly once at creation or rotation. The control plane stores hashes
  only.
- **R2 public domain is intentionally unauthenticated** — SHA-256 keys
  are the unguessability boundary, URL is a capability. See the
  ["R2 public custom domain" section](/security/threat-model#r2-public-custom-domain)
  of the threat model.
