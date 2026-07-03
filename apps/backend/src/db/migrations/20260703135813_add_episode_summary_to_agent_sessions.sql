-- Add episode_summary to agent_sessions (roadmap 3.1).
-- Post-completion metadata of the session itself: a ~2-3 sentence condensation
-- of what the persona did and concluded, written by a background summary job
-- after the session completes. NULL until that job runs (and for sessions that
-- produced no output). Read back into later turns' context as "Previous
-- sessions" so "as we discussed last week" survives the context window scrolling
-- past. A column, not a tracking table: it is metadata of the session row, not
-- transient workflow state (INV-57).
ALTER TABLE agent_sessions
ADD COLUMN IF NOT EXISTS episode_summary TEXT;
