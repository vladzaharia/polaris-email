# Audit anchor maintenance

The hourly `anchor` cron in `services/api` signs the latest `audit_log`
row hash and writes the anchor to an external Object-Lock target
(Backblaze B2 by default). The off-platform write is the integrity fence
for the single-account Cloudflare topology: a fully compromised CF
account cannot rewrite history because the B2 credentials live outside
CF and the bucket enforces Object Lock COMPLIANCE.

This runbook covers detection and recovery for anchor failures.

## Detection signals

- `cron_runs.job_name = 'anchor'` row has `status = 'error'`.
- `audit_anchors` rows accumulate with `external_ref_at IS NULL`.
- Structured log lines: `{"event":"anchor_b2_write_failed", ...}`.
- The daily `anchor-backfill` cron logs `stale unconfirmed anchor` for
  rows older than 7 days.

The panel surfaces last-success times via the `cron_runs` table; an
anchor that hasn't landed in B2 in the last 25 hours is overdue.

## Quick health check

```sh
# D1 side — are there unanchored rows?
wrangler d1 execute polaris-email --command "
  SELECT COUNT(*) FROM audit_anchors WHERE external_ref_at IS NULL;
"

# B2 side — does the bucket have the expected key?
b2 file info "b2://polaris-anchors/anchors/$signed_at-$audit_id.json"
```

If both confirm the gap, recovery depends on the cause.

## Failure mode: transient B2 outage

The hourly cron writes the D1 row first, then attempts the B2 PUT. On
B2 failure the row keeps `external_ref_at = NULL`. The daily backfill
cron (`15 5 * * *`) re-attempts the B2 PUT.

No operator action required if the outage clears within 7 days; the
backfill cron will heal the gap automatically. If older, the backfill
logs `stale unconfirmed anchor` and pages — file the row id and run a
manual re-publish:

```sh
# Get the row
wrangler d1 execute polaris-email --command "
  SELECT id, external_ref, last_audit_id, last_row_hash, signature, signed_at
  FROM audit_anchors WHERE id = $id;"

# Re-publish to B2 (mirrors what putObjectWithLock would write)
b2 file upload polaris-anchors $local_file $external_ref \
  --legal-hold on --file-retention-mode compliance \
  --file-retention-retain-until-days 2555

# Mark the row confirmed
wrangler d1 execute polaris-email --command "
  UPDATE audit_anchors SET external_ref_at = datetime('now') WHERE id = $id;"
```

## Failure mode: signing key rotation

The `ANCHOR_SIGNING_KEY` wrangler secret is the HMAC key for the anchor
canonical (`polaris-email/anchor\\n<id>\\n<row_hash>\\n<ts>`). Rotation
procedure:

1. Generate the new key:
   `openssl rand 32 | base64`. Capture in your operator vault.
2. Push the new secret:
   `wrangler secret put ANCHOR_SIGNING_KEY` (the next hourly anchor will
   sign with the new key).
3. **Do not delete the previous key from your vault** — every anchor
   signed before the rotation requires it for re-verification.

The chain-verification cron (`30 5 * * *`) does not run signature
verification; that happens out-of-band with `bin/audit-verify.sh` (which
the operator runs from a host that has the relevant signing key
available).

## Failure mode: B2 credential exhaustion

The `ANCHOR_S3_ACCESS_KEY_ID` / `ANCHOR_S3_SECRET_ACCESS_KEY` wrangler
secrets are scoped write-only to the anchor bucket. Rotation:

1. Create a new B2 application key with `writeFiles` scope on the
   `polaris-anchors` bucket.
2. `wrangler secret put ANCHOR_S3_ACCESS_KEY_ID` and `... SECRET_ACCESS_KEY`.
3. Wait one hour and confirm the next anchor lands.
4. Revoke the old B2 key only after verification.

## Verify the chain end-to-end

Manual verification (from a host with the signing key):

```sh
bin/audit-verify.sh --from-id 0 --signing-key-file /path/to/key
```

The script walks every row in D1, recomputes each `row_hash`, and
cross-checks `audit_anchors` for the matching B2 keys. Any divergence is
a critical incident — escalate immediately.

## Why anchors must stay off-Cloudflare

Documented in `SECURITY.md`. Two reasons:

1. A fully-compromised CF account cannot rewrite history because the B2
   credentials are operator-vault-only.
2. Object Lock COMPLIANCE mode prevents _anyone_ — including the B2
   support team — from deleting anchors before their retain-until date.

Do not move anchor writes back into CF without re-evaluating the threat
model with the security review checklist in `SECURITY.md`.
