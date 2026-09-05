-- =============================================================================
-- messages.embedding_source_hash: which text the stored vector was computed from
-- =============================================================================
--
-- sha256 of the exact text passed to the embedding model. The live worker and
-- the message-embeddings-context backfill both skip a row whose hash already
-- matches and write only when the stored hash still equals the one they
-- observed before embedding, so a slow embed of older text can never overwrite
-- a newer one (INV-20). NULL = embedded before this column existed, or never.

ALTER TABLE messages ADD COLUMN embedding_source_hash TEXT;
