-- Companion session sponsor, execution generation and persisted financial stop.
-- initiating_user_id stays NULL on historical rows: it is never inferred.
-- execution_generation fences lifecycle writes of a replaced executor (INV-66).
-- stop_reason is code-validated TEXT (INV-3); NULL means not stopped.

ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS initiating_user_id TEXT,
  ADD COLUMN IF NOT EXISTS execution_generation INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stop_reason TEXT;
