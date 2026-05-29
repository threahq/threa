-- Bot Identity Key (BIK) registration on bot_runtime_instances.
--
-- A runtime (Pi remote, BYO) generates a fresh X25519 keypair on each session
-- and registers the public half here so the per-stream symmetric key (SSK) can
-- be HPKE-wrapped to it when the bot is invited into an E2E scratchpad. The
-- private half never leaves the runtime device. `public_key_id` is the short
-- id used as `recipient_key_id` in stream_e2e_key_wraps (mirrors EIK/UIK).
--
-- Both nullable + additive (INV-17): non-E2E runtimes never register a key, and
-- existing rows predate the feature. The pubkey crosses the wire/storage as
-- base64 TEXT — opaque to the server, which never inspects it — so the hot
-- `SELECT *` / `RETURNING *` presence reads need no BYTEA encode/decode.

ALTER TABLE bot_runtime_instances
  ADD COLUMN IF NOT EXISTS public_key TEXT;

ALTER TABLE bot_runtime_instances
  ADD COLUMN IF NOT EXISTS public_key_id TEXT;
