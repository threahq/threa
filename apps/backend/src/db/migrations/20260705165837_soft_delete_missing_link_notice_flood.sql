-- One-time cleanup of the missing-session-link notice feedback loop.
--
-- Before the guard in BotInvocationOutboxHandler.processMessageCreated
-- (same PR), the "… is not linked to this scratchpad" system notice was
-- itself a message:created event that re-entered the handler and produced
-- another notice, flooding the affected scratchpad with thousands of
-- system messages (~3/s in production).
--
-- Soft-delete, not hard-delete: the notices' message_created stream_events
-- keep their broadcast_sequence slots, so the per-stream broadcast chain
-- stays dense (INV-61) and clients render deleted placeholders instead of
-- detecting phantom holes. The only sanctioned slot-vacating mechanism is
-- the messages:moved tombstone, which this is not. Derived volume (outbox,
-- sync_log, queue_messages) is aged out by the existing retention workers
-- and is not touched here.
--
-- Targets exactly the rows the handler stamped: system-authored messages
-- carrying the bot_runtime.notice=missing_session_link metadata (uses the
-- idx_messages_metadata_gin index). Legitimate future notices are still
-- posted for user-authored messages; deleting all historical ones is fine —
-- they are transient guidance, not content.
--
-- No user_activity sweep is needed: the activity outbox handler already
-- skips system-authored messages (features/activity/outbox-handler.ts), so
-- these notices never created unread rows.
--
-- Idempotent (deleted_at guard). Runs before the server accepts
-- connections, so no outbox events are emitted; live clients converge on
-- their next reconnect bootstrap (INV-53).

UPDATE messages
SET deleted_at = NOW()
WHERE author_type = 'system'
  AND metadata @> '{"bot_runtime.notice":"missing_session_link"}'::jsonb
  AND deleted_at IS NULL;
