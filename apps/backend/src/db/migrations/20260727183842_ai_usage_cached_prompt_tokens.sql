-- Record how many prompt tokens the provider served from its cache.
-- OpenRouter already reports this per call (promptTokensDetails.cachedTokens);
-- without a column the value is discarded, so cache effectiveness is invisible
-- and has to be inferred by reconstructing each bill from list prices.
--
-- Backfill is deliberately absent: the value is unknowable for existing rows,
-- and 0 is the truthful reading for them (no call before this column landed
-- placed a cacheable prefix on any background component).

ALTER TABLE ai_usage_records
ADD COLUMN IF NOT EXISTS cached_prompt_tokens INTEGER NOT NULL DEFAULT 0;
