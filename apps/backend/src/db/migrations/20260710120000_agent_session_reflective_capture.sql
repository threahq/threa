-- Reflective capture at session completion (roadmap 6.3).
--
-- After a research-heavy companion session completes, a post-completion job
-- distils its tool-work digest + reply into at most a couple of agent-authored
-- memos (the same GAM classifier/memorizer pipeline, a second caller — INV-35).
-- Those memos anchor to the session's own trigger/reply messages, so they keep
-- memo_type 'message' and flow through the existing message-sourced retrieval
-- unchanged (no memo_type/CHECK change needed); `authored_by_kind` = 'agent' and
-- `source_session_id` (both from the 6.2 columns) carry their provenance.
--
-- `reflective_captured_at` is the idempotency marker: the reflective job CASes it
-- from NULL exactly once, so a re-delivered job never re-runs the classifier or
-- stacks a second, differently-worded capture (the memorizer is non-deterministic,
-- so the embedding dedup gate alone can't guarantee once-only across re-delivery).
-- NULL until the job runs; set even when the session yielded no memo, so a
-- not-worthy session isn't re-classified on every redelivery.

ALTER TABLE agent_sessions
ADD COLUMN IF NOT EXISTS reflective_captured_at TIMESTAMPTZ;
