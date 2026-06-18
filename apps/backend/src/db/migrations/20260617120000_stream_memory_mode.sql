-- Per-stream gate for GAM memory automation. 'auto' preserves today's
-- behavior (the memo accumulator queues conversations for extraction); 'off'
-- excludes the stream so a high-volume scratchpad (e.g. a coding-agent build
-- session) can opt out of memo extraction and passive to-do capture. Threads
-- inherit from their root stream, so the flag is only meaningful on
-- non-thread streams; the accumulator reads it on the resolved top-level
-- stream. No DB enum (INV-3) — TEXT validated in app code.
ALTER TABLE streams
  ADD COLUMN memory_mode TEXT NOT NULL DEFAULT 'auto';
