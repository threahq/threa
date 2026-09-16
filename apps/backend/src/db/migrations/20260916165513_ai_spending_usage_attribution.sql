ALTER TABLE ai_spending_attempts
  ADD COLUMN IF NOT EXISTS function_id TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'openrouter';

ALTER TABLE ai_spending_attempts
  ALTER COLUMN function_id DROP DEFAULT,
  ALTER COLUMN provider DROP DEFAULT;
