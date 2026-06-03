-- Encrypted copy of an E2E stream's display name.
--
-- The plaintext `streams.display_name` stays as the always-visible fallback
-- (shown while the viewer's E2E session is locked); this sealed copy is the
-- authoritative name an unlocked client decrypts and prefers. Sealed under the
-- stream SSK with AAD bound to (streamId, "name", generation) — the server
-- stores opaque ciphertext + framing it cannot read.
--
-- Additive and nullable: existing E2E streams simply have no sealed name until
-- the next rename writes one, and plaintext streams never get these columns set.
ALTER TABLE e2e_streams
  ADD COLUMN name_ciphertext BYTEA,
  ADD COLUMN name_envelope JSONB;
