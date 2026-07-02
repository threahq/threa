-- Remember the conversation a message was saved from.
--
-- A message can be saved from a conversation surface (board card, conversation
-- panel) as well as from its home-stream timeline. When it's saved from a
-- conversation, we record that origin so the Saved list, the Activity-feed
-- reminder, and the web-push reminder all deep-link back into the conversation
-- panel (`?panel=conv:<id>&m=<msgId>`) instead of the bare stream permalink.
--
-- Nullable: stream-origin saves and standalone (message-less) to-dos leave it
-- NULL. It's a display-origin hint validated at write time (workspace-scoped +
-- the message's access root must match the conversation's root), never a
-- foreign key (INV-1). Not indexed — it's read only as part of a row already
-- fetched by id/list, never queried on its own.

ALTER TABLE saved_messages ADD COLUMN IF NOT EXISTS conversation_id TEXT;
