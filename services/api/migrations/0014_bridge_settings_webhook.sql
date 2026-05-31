-- 0014_bridge_settings_webhook.sql
--
-- Add panel-controllable webhook settings to bridge_settings. Until
-- now webhook config lived only as bridge env vars (BRIDGE_WEBHOOK_ENABLED,
-- BRIDGE_PUBLIC_URL), which meant operators had to redeploy the
-- container to change anything — including the URL polaris uses to
-- deliver inbound mail. After this migration the bridge reads its
-- webhook config from the heartbeat-delivered settings, the panel
-- has full toggle + URL override controls, and `webhook_url_override`
-- empty means "auto-derive" (bridge picks the most-specific reachable
-- address: tailnet MagicDNS → <name>.mail.plrs.im → raw IP).
--
-- New columns:
--   * `webhook_enabled` (default 1) — toggle the receiver listener.
--   * `webhook_url_override` (TEXT NULL) — explicit URL polaris should
--     POST to. NULL = auto-derive on the bridge side.
--
-- The bridge applies webhook_enabled hot (start/stop the listener);
-- URL changes flag restart-required so the registered webhook sub
-- gets re-bootstrapped against the new URL on next boot.

PRAGMA foreign_keys = OFF;

-- Default OFF: operators opt in via the panel once they've decided
-- which transport (tailnet / public URL / raw IP) is appropriate for
-- their environment. Defaulting to on would silently bootstrap webhook
-- subscriptions polaris can't reach (the previous BRIDGE_PUBLIC_URL
-- env-var dance), which is exactly the surface we're moving away from.
ALTER TABLE bridge_settings ADD COLUMN webhook_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bridge_settings ADD COLUMN webhook_url_override TEXT;

PRAGMA foreign_keys = ON;
