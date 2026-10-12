CREATE TABLE IF NOT EXISTS traffic_stats_daily (
  day_start INTEGER NOT NULL,
  event TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (day_start, event)
);

CREATE INDEX IF NOT EXISTS traffic_stats_daily_day_idx ON traffic_stats_daily(day_start);
