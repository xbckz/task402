CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  payment_key TEXT UNIQUE,
  payment_fingerprint TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  capability_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'rendered', 'settling', 'complete', 'render_failed', 'payment_failed', 'settlement_unknown', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  payment_retain_until INTEGER NOT NULL,
  artifact_key TEXT,
  artifact_bytes INTEGER,
  settlement_json TEXT,
  error_code TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT
);

CREATE INDEX IF NOT EXISTS jobs_expiry_idx ON jobs(expires_at);
CREATE INDEX IF NOT EXISTS jobs_retention_idx ON jobs(state, payment_retain_until);
