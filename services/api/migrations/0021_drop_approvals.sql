-- polaris-email — drop the two-person approvals table (schema version=21)
--
-- The dual-admin approval flow is removed; real deployments are
-- single-operator and the second-admin co-sign step was unusable. Destructive
-- actions are now gated client-side by DestructiveActionDialog (type the
-- resource name to confirm). The audit_log chained-hash table (anchored
-- hourly to Backblaze B2 with Object Lock) remains the canonical record of
-- who did what.

DROP TABLE IF EXISTS approvals;

INSERT INTO schema_migrations (version, applied_at, sha)
VALUES (21, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0021_drop_approvals');
