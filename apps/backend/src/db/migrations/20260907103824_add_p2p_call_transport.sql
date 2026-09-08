ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS transport_generation INTEGER NOT NULL DEFAULT 1;

ALTER TABLE call_endpoints
  ADD COLUMN IF NOT EXISTS transport_capability TEXT;
