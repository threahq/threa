-- Client-supplied idempotency key for trace steps.
--
-- The bot-runtime client (extensions/bot-runtime-client) routes trace steps over
-- the /bot WebSocket and only falls back to HTTP when the socket is down, so a
-- step is normally written once. This external key makes that idempotent by
-- construction at the data layer: a step re-sent under the same `client_step_id`
-- (a slow-ack retry, a future at-least-once mode, or a double-delivery) dedups to
-- the row the first send created instead of appending a duplicate trace entry.
--
-- Nullable + partial-unique so every existing caller (in-process companion,
-- enclave, sealed steps) that supplies no key is unaffected.
ALTER TABLE agent_session_steps ADD COLUMN client_step_id TEXT;

CREATE UNIQUE INDEX agent_session_steps_client_step_id_key
  ON agent_session_steps (session_id, client_step_id)
  WHERE client_step_id IS NOT NULL;
