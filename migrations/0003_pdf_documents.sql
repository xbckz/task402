CREATE TABLE IF NOT EXISTS pdf_documents (
  id TEXT PRIMARY KEY,
  idempotency_hash TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  recovery_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  capability_hash TEXT NOT NULL,
  file_name TEXT NOT NULL,
  page_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  index_key TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS pdf_documents_expiry_idx ON pdf_documents(expires_at);
