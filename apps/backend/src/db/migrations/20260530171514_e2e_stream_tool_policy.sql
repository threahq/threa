-- Per-stream agent tool-privacy policy for E2E scratchpads.
--
-- NULL means "no restriction" (all tool categories allowed) and is the default,
-- so this column is a no-op until an owner sets a policy. A non-null array
-- restricts the enclave agent to exactly the listed coarse categories
-- (e.g. {'web'} = web egress but nothing else, {} = no tools at all); the
-- 'messaging' reply tool is always allowed regardless. Validated in code, not by
-- a DB enum (INV-3). The server stores only this coarse list, never plaintext.
ALTER TABLE e2e_streams
  ADD COLUMN allowed_tool_categories TEXT[];
