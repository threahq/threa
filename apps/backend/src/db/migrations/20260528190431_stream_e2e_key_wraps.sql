-- Per-stream symmetric key (SSK) wrap storage.
--
-- Every E2E stream owns an AES-256 SSK that seals its messages (envelope
-- v2, see @threa/crypto stream-key.ts). The SSK itself is never stored in
-- plaintext: it exists only HPKE-wrapped to each authorized recipient's
-- long-term public key (a member's UIK or a live enclave EIK). One row here
-- per (stream, key_generation, recipient). A recipient fetches its own wrap
-- and unwraps the SSK with its private key; the server never sees the SSK.
--
-- `key_generation` lets the SSK roll forward without re-encrypting history:
-- when the recipient set changes (e.g. an enclave is invited or its EIK
-- rotates), a fresh generation's SSK is wrapped to the new set while old
-- generations stay decryptable by whoever already held them. Messages carry
-- their sealing generation in the envelope, so a reader picks the matching
-- wrap. For owner-only loopback streams there is a single generation 0.
--
-- Workspace-scoped product data (INV-8): every read/write filters on
-- workspace_id. `skw_` ULID id per INV-2. `recipient_kind` is TEXT validated
-- in code (INV-3).
CREATE TABLE stream_e2e_key_wraps (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  key_generation INTEGER NOT NULL,
  recipient_key_id TEXT NOT NULL,
  recipient_kind TEXT NOT NULL,        -- 'user' | 'enclave' | 'bot'
  wrap_enc BYTEA NOT NULL,             -- HPKE encapsulation
  wrap_ct BYTEA NOT NULL,              -- HPKE-wrapped SSK bytes
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One wrap per recipient per generation. Backs the race-safe upsert (INV-20)
-- so concurrent wrap writers (owner create + enclave invite) can't duplicate
-- a slot, and binds the slot the wrap AAD is computed over.
CREATE UNIQUE INDEX uq_stream_e2e_key_wraps_slot
  ON stream_e2e_key_wraps (workspace_id, stream_id, key_generation, recipient_key_id);

-- "Fetch my wrap for this stream, newest generation first" — the read a
-- device makes to recover the SSK after a refresh or on another device.
CREATE INDEX idx_stream_e2e_key_wraps_recipient
  ON stream_e2e_key_wraps (workspace_id, stream_id, recipient_key_id, key_generation DESC);

-- The SSK generation a stream's new messages currently seal under. Owner-only
-- streams stay at 0; a future re-wrap (enclave invite / EIK rotation) bumps it.
ALTER TABLE e2e_streams
  ADD COLUMN current_key_generation INTEGER NOT NULL DEFAULT 0;
