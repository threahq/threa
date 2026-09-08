ALTER TABLE call_transfer_obligations
  ADD COLUMN IF NOT EXISTS restored_to_source BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS restored_to_source_at TIMESTAMPTZ;
