CREATE TABLE IF NOT EXISTS tool_stats_hourly (
  bucket_start INTEGER NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  payment_required INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (bucket_start)
);

CREATE INDEX IF NOT EXISTS tool_stats_hourly_bucket_idx ON tool_stats_hourly(bucket_start);

INSERT OR IGNORE INTO tool_stats_hourly
  (bucket_start, calls, successes, errors, payment_required, last_seen_at)
SELECT day_start,
  SUM(calls), SUM(successes), SUM(errors), SUM(payment_required), MAX(last_seen_at)
FROM tool_stats_daily
GROUP BY day_start;
