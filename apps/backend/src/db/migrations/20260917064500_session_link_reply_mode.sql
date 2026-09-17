-- Where a linked runtime session answers a message posted at its scratchpad
-- root: 'flat' in the scratchpad, 'thread' in a thread anchored on the message.
-- TEXT validated in code (INV-3). Session upserts never set it, so a relink
-- keeps the mode the user chose.
ALTER TABLE bot_runtime_session_links ADD COLUMN IF NOT EXISTS reply_mode TEXT NOT NULL DEFAULT 'flat';
