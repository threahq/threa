-- System-purpose marker for a stream. NULL (the default for every existing and
-- ordinary new stream) means a normal user-facing stream. 'persona_test' marks
-- the ephemeral scratchpad bound to a persona-editor draft: a real,
-- fully-functional stream that runs companion turns, but a workbench rather than
-- a channel, so the sidebar and workspace stream lists exclude it. No DB enum
-- (INV-3) — TEXT validated in app code.
ALTER TABLE streams
  ADD COLUMN purpose TEXT;
