CREATE TABLE IF NOT EXISTS tool_stats_daily (
  day_start INTEGER NOT NULL,
  tool TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  payment_required INTEGER NOT NULL DEFAULT 0,
  settled_calls INTEGER NOT NULL DEFAULT 0,
  settled_amount_atomic INTEGER NOT NULL DEFAULT 0,
  total_duration_ms INTEGER NOT NULL DEFAULT 0,
  max_duration_ms INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (day_start, tool)
);

CREATE INDEX IF NOT EXISTS tool_stats_daily_day_idx ON tool_stats_daily(day_start);
