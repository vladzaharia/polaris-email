-- 0015_bridge_bootstrap_window.sql
--
-- Self-healing bridge plaintext cache + installer-link teardown.
--
-- Symmetric HMAC means the api verifies every bridge request by
-- recomputing the MAC against the bridge's plaintext secret, cached in
-- KV (`bridge_plain:<id>`). That cache had a fixed 1h TTL that nothing
-- refreshed, so ~1h after registration the api could no longer verify
-- the bridge at all (`key_propagating`). The fix refreshes the cache on
-- every heartbeat with a dynamic TTL that ramps 8h → 7d as the bridge
-- earns reliability, so a long-lived bridge survives a longer outage.
--
-- Adds three columns to `bridges`:
--   * `first_heartbeat_at TEXT` — tenure anchor, set once on the first
--     heartbeat. Drives the tenure factor of the dynamic TTL.
--   * `availability_ewma REAL` — rolling 0..1 availability (EWMA over a
--     ~30d time constant). NULL ⇒ treat as 1.0 (no history yet).
--   * `installer_window_expires_at TEXT` — installer-link teardown gate.
--     The install URL 404s once `now >= installer_window_expires_at` OR
--     the column is NULL. New registrations/rotations open an 8h window;
--     the first successful heartbeat closes it early.
--
-- Backfill: leave all three NULL for existing rows. NULL
-- `installer_window_expires_at` ⇒ the link is already closed (existing
-- bridges roll to mint a fresh one). NULL ewma/first_heartbeat_at are
-- initialised on the next heartbeat. Per pre-production policy, resetting
-- tenure clocks for the handful of existing bridges is acceptable.
--
-- No `audit_log` CHECK rebuild: no new audit actions. No schema/openapi
-- change: bridge-facing response shapes are unchanged.

PRAGMA foreign_keys = OFF;

ALTER TABLE bridges ADD COLUMN first_heartbeat_at          TEXT;
ALTER TABLE bridges ADD COLUMN availability_ewma           REAL;
ALTER TABLE bridges ADD COLUMN installer_window_expires_at TEXT;

PRAGMA foreign_keys = ON;
