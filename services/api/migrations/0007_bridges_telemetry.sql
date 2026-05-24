-- 0007_bridges_telemetry.sql
--
-- Wires up the data the new "first-class bridge" panel needs:
--   * Adds three telemetry columns to `bridges` so the latest heartbeat
--     can be rendered without a separate history table.
--   * Adds an index on `messages(bridge_id, created_at)` so the new
--     per-bridge activity rollup is index-driven, not a table scan.
--
-- `bridges.last_seen_at` already exists; nothing schema-side to change
-- there. The accompanying code change starts writing to it from
-- `bridgeHmacAuth()` so the column stops being silently always-null.
--
-- No FK changes; no defer_foreign_keys ordering required.

ALTER TABLE bridges ADD COLUMN last_heartbeat_at   TEXT;
ALTER TABLE bridges ADD COLUMN last_heartbeat_json TEXT;
ALTER TABLE bridges ADD COLUMN bridge_version      TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_bridge_created
  ON messages(bridge_id, created_at DESC);
