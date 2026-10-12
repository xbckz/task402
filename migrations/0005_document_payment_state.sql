ALTER TABLE pdf_documents ADD COLUMN payment_key TEXT;
ALTER TABLE pdf_documents ADD COLUMN payment_fingerprint TEXT;
ALTER TABLE pdf_documents ADD COLUMN payer TEXT;
ALTER TABLE pdf_documents ADD COLUMN payment_state TEXT NOT NULL DEFAULT 'complete';
ALTER TABLE pdf_documents ADD COLUMN settlement_json TEXT;
ALTER TABLE pdf_documents ADD COLUMN error_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS pdf_documents_payment_key_idx ON pdf_documents(payment_key) WHERE payment_key IS NOT NULL;
