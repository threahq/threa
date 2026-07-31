-- Settling state for a message's conversation assignment: the extractor placed
-- it with low confidence, so the placement is provisional until a human engages
-- with the message or the extraction window moves past it. Transient workflow
-- state, so it lives beside `messages` rather than on it (INV-57); absence of a
-- row means settled/normal.
CREATE TABLE message_conversation_state (
  message_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  -- The conversation the message is provisionally in. Moves with the message
  -- when a later pass (or a user) re-files it, so the row never points at a
  -- conversation the message has left.
  conversation_id TEXT NOT NULL,
  state TEXT NOT NULL,
  settled_by TEXT,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_message_conversation_state_conversation
  ON message_conversation_state (conversation_id, state);

CREATE INDEX idx_message_conversation_state_stream
  ON message_conversation_state (stream_id, state);

-- The sweep backstop's read: still-settling rows by age. Partial — settled rows
-- are the steady-state majority and the sweep never reads them.
CREATE INDEX idx_message_conversation_state_settling_age
  ON message_conversation_state (created_at)
  WHERE state = 'settling';
