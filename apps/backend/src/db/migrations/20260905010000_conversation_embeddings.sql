-- Conversations become a search unit of their own: the topic summary, summary
-- and opening message are embedded so a vague query can land on a whole
-- discussion instead of one message. `embedding_source_hash` is the sha256 of
-- the embedded text so re-extraction only re-embeds when the text changed.
ALTER TABLE conversations
  ADD COLUMN embedding vector(1536),
  ADD COLUMN embedding_source_hash TEXT;

CREATE INDEX idx_conversations_embedding
  ON conversations USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
