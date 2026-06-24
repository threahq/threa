-- Authored board posts declare a human boundary the AI must not re-cluster.
-- A board "New post" creates a message + a conversation seeded with it, in one
-- transaction; this flag marks that message so the async boundary-extraction
-- worker skips it (never reassigns it, never re-clusters it). It is a durable
-- structural property of the message, not transient workflow state — the human
-- assignment wins over the async AI pass (INV-20).
ALTER TABLE messages ADD COLUMN is_authored_boundary BOOLEAN NOT NULL DEFAULT FALSE;
