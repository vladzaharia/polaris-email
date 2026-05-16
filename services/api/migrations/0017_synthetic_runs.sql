-- W11 — Synthetic monitoring runs ledger.
--
-- One row per execution of any synthetic monitoring cron (MTA-STS
-- continuity, DKIM self-verify, future per-domain round-trip). The panel's
-- /diagnostics page reads this to render last-N status + latency.

CREATE TABLE synthetic_runs (
  id              TEXT PRIMARY KEY,
  check_kind      TEXT NOT NULL
                    CHECK (check_kind IN (
                      'mta_sts_continuity',
                      'dkim_self_verify',
                      'roundtrip_send',
                      'healthz'
                    )),
  -- The thing being checked. For per-domain checks this is the domain
  -- name; for global checks it's a sentinel like 'global'.
  target          TEXT NOT NULL,
  ok              INTEGER NOT NULL CHECK (ok IN (0, 1)),
  latency_ms      INTEGER,
  detail          TEXT,             -- JSON-or-plain free-form info
  run_at          TEXT NOT NULL
);

CREATE INDEX idx_synthetic_runs_kind_run_at  ON synthetic_runs(check_kind, run_at DESC);
CREATE INDEX idx_synthetic_runs_target       ON synthetic_runs(target, run_at DESC);
CREATE INDEX idx_synthetic_runs_run_at       ON synthetic_runs(run_at DESC);
