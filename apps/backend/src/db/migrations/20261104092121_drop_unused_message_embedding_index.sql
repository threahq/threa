-- The HNSW index on messages.embedding never serves a read: semantic search
-- ranks with ROW_NUMBER() OVER (ORDER BY embedding <=> ...), which pgvector
-- cannot answer from an HNSW index, so every search scans exactly. Its only
-- effect is write cost: each embedding update walks the graph, keeping ~150 MB
-- of it in the page cache Railway bills as RAM.
--
-- Standalone single-statement file so CONCURRENTLY works: the migration runner
-- runs a multi-statement file as one implicit transaction.
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_embedding;
