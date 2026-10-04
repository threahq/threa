-- One command at a time per stream's sandbox, from the reuse check until the
-- command ends, across backend replicas. A holder renews before expiry; a
-- crashed holder's row is taken over once it expires.
CREATE TABLE stream_sandbox_leases (
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, stream_id)
);
