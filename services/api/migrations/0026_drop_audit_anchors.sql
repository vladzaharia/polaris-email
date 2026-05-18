-- 0026 — Drop the audit_anchors table.
--
-- Audit anchors were off-platform (Backblaze B2 + Object Lock COMPLIANCE)
-- hash signatures written hourly to defend against a fully-compromised
-- Cloudflare account. The mechanism was removed in favour of a simpler
-- model: audit_log keeps its in-row chained SHA-256 (each row's row_hash
-- is HMAC(prev_hash || canonical_row) so any out-of-band rewrite breaks
-- the chain), and the audit-verify cron walks the chain end-to-end
-- nightly. That covers the same accidental / sloppy-DB-write scenarios;
-- it does not defend against a CF-side rewrite, which is now an
-- accepted trade-off (see SECURITY.md threat model).
--
-- Dropping the table reclaims storage and removes a dead read surface.
-- The audit-verify cron reads only audit_log, so this drop has no
-- runtime impact on chain verification.

DROP TABLE IF EXISTS audit_anchors;

INSERT INTO schema_migrations (version, applied_at, sha)
VALUES (26, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0026_drop_audit_anchors');
