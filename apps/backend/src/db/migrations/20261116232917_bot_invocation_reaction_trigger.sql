-- Reaction invocations coalesce human reactions on a bot's message into one
-- pending turn per (message, bot). The turn that is already running (claimed)
-- must not block the next reaction from queueing, so reaction rows leave the
-- one-active-row-per-trigger key and get their own one-pending-row key instead.
-- trigger and required_capability are TEXT without CHECK constraints, so the
-- new values need no schema change.
DROP INDEX IF EXISTS idx_bot_invocations_active_source_actor_trigger;

CREATE UNIQUE INDEX idx_bot_invocations_active_source_actor_trigger
  ON bot_invocations (workspace_id, source_message_id, actor_type, actor_id, trigger)
  WHERE status IN ('pending', 'claimed') AND trigger <> 'reaction';

CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_invocations_pending_reaction
  ON bot_invocations (workspace_id, source_message_id, actor_id)
  WHERE trigger = 'reaction' AND status = 'pending';
