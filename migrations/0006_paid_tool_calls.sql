CREATE TABLE IF NOT EXISTS paid_tool_calls (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  payment_key TEXT UNIQUE,
  payment_fingerprint TEXT NOT NULL,
  tool TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  payer TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  result_json TEXT,
  settlement_json TEXT,
  error_code TEXT
);

CREATE INDEX IF NOT EXISTS paid_tool_calls_expiry_idx ON paid_tool_calls(expires_at);
