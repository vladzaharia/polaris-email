---
title: Cloudflare account compromise
description: Time-to-contain target 15 minutes. Containment (kill switches), investigation (Logpush + B2 anchor cross-check), and recovery (secret rotation, PITR restore, synthetic) for a full CF-account compromise.
sidebar_label: CF account compromise
sidebar_position: 4
---

# Runbook: Cloudflare account compromise

Assume the polaris-email Cloudflare account has been (or is suspected of being) compromised. Time-to-contain target: 15 minutes.

## Threat model — single-account topology, off-platform integrity fence

Phase O1 collapsed Polaris to **one Cloudflare account** (`polaris-prod`).
That account hosts every runtime: Workers, D1, KV, R2, Queues, DNS, Email
Routing, Email Service, Access. A full compromise of the CF account
therefore has a wide blast radius — the attacker can mint Worker deploys,
read/write D1, read/write the `polaris-email` R2 bucket, redirect MX
records, and pull every Workers Secret (`POLARIS_SECRET_A`, the bcrypt
pepper, the bridge HMAC key, etc.).

**The integrity fence is the audit-anchor target, which lives OUTSIDE
Cloudflare.** Hourly anchors are written by `services/api/src/scheduled/anchor.ts`
to a Backblaze B2 bucket with Object Lock COMPLIANCE mode and a default
7-year retention (`packages/object-lock`). Three properties matter:

1. **B2 credentials are NOT Workers Secrets.** They live in the operator's
   password vault (1Password / equivalent). A compromised CF account
   cannot read them.
2. **The B2 Application Key is scoped write-only** to the anchor bucket. No
   delete, no overwrite of existing objects, no other-bucket access.
3. **Object Lock COMPLIANCE** means even the B2 account owner cannot
   shorten the retention or delete an object before its retain-until date.

So an attacker with full CF takeover can:

- Stop NEW anchors from being written (by killing the Worker).
- NOT rewrite or delete existing anchors.
- NOT forge a backdated anchor (B2's retain-until date is set by our signer
  using the local clock at write time; a backdated payload wouldn't match
  the chain the historical anchors witness).

This means the audit chain remains tamper-evident across a CF compromise.
Recovery starts by re-anchoring against the B2 chain and reconciling D1
back to whatever last known-good `last_row_hash` the anchors witness.

## Containment

1. **Revoke all CF API tokens** in the Cloudflare dashboard. Cannot be
   scripted (cannot revoke the credential one is authenticated with).
2. **Freeze D1 writes** by deploying the maintenance Worker:
   ```sh
   bin/killswitch-freeze.sh
   ```
   This redeploys `polaris-email-api` with a maintenance handler that returns
   `503 degraded` for every route except `/healthz` and `/admin/killswitch`.
3. **MX flip** to a holding domain that 4xx-tempfails inbound so no mail is
   lost:
   ```sh
   bin/killswitch-mx-flip.sh in.example.com hold.example.com
   ```
4. **R2 lifecycle pause** to prevent any retention deletes from racing the
   investigation:
   ```sh
   bin/killswitch-r2-pause.sh
   ```
   The `polaris-email` R2 bucket holds bodies + attachments; this is
   distinct from the off-platform audit-anchor bucket on Backblaze B2,
   which is already Object-Lock-protected and needs no separate freeze.
5. **Pull the B2 Application Key out of rotation** (rotate via the B2
   console). This forces the Worker to fail-loud on the next anchor cron
   instead of silently appending under a stolen key (though the Worker
   itself is also frozen via step 2).
6. **Panel offline**: scale `polaris-email-panel` to 0 / pause its
   container.
7. **Comms**: open [Internal comms](/operators/runbooks/comms/breach-internal) and
   [Customer comms](/operators/runbooks/comms/breach-customers).

## Investigation

- Pull the **Logpush mirror** (external append-only store). Worker logs,
  D1 audit rows, R2 access logs.
- **Verify the audit chain** using `bin/audit-verify.sh` and the latest
  `audit_anchors` rows vs the anchor objects in the B2 bucket. Any
  divergence between a D1 anchor row and the corresponding B2 object body
  is the tamper-evidence signal: the B2 copy is authoritative.
- List recent B2 anchors with the operator-vault-held credentials:
  ```sh
  aws s3api list-objects-v2 \
    --bucket polaris-anchors \
    --prefix anchors/ \
    --endpoint-url https://s3.us-west-005.backblazeb2.com
  ```
  And spot-check retention on a recent object:
  ```sh
  aws s3api get-object-retention \
    --bucket polaris-anchors --key anchors/<ts>-<id>.json \
    --endpoint-url https://s3.us-west-005.backblazeb2.com
  # → Mode: COMPLIANCE, RetainUntilDate: <date>
  ```
- Diff D1 head's `row_hash` against the most recent anchor signature
  recovered from B2.

## Recovery

1. Rotate every secret (every API key, IMAP/SMTPS password, webhook secret,
   `POLARIS_SECRET_A`, anchor HMAC signing key). All emergency-mode.
   Rotate the B2 Application Key too; the new one lands via `wrangler
secret put ANCHOR_S3_ACCESS_KEY_ID` / `ANCHOR_S3_SECRET_ACCESS_KEY`.
2. Redeploy from a clean source checkout pinned to a digest known to
   predate the compromise.
3. Restore D1 from PITR to a point before the compromise; reconcile
   against R2 (which is append-only / locked) and against the B2 anchor
   chain (which the attacker could not have rewritten).
4. Verify Logpush mirror integrity, confirm audit-chain anchors line up
   with the B2 copies.
5. Unfreeze: undo MX flip, undo killswitch deploy, restart panel.
6. Run the diagnostics page; confirm green ticks.
7. Run the synthetic for 24 h before any real consumer is unfrozen.

<!-- Verified against: docs/runbooks/cf-account-compromise.md @ c3c1b5048dd5bfe92facdce24982141a07446042 -->
