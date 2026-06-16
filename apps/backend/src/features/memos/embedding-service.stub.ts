import type { EmbeddingServiceLike, EmbeddingContext } from "./embedding-service"
import { logger } from "../../lib/logger"

const STUB_EMBEDDING_DIMENSION = 1536

export class StubEmbeddingService implements EmbeddingServiceLike {
  async embed(_text: string, _context?: EmbeddingContext): Promise<number[]> {
    logger.debug("Stub embedding service - returning zero vector")
    return new Array(STUB_EMBEDDING_DIMENSION).fill(0)
  }

  async embedBatch(texts: string[], _context?: EmbeddingContext): Promise<number[][]> {
    logger.debug({ count: texts.length }, "Stub embedding service - returning zero vectors")
    return texts.map(() => new Array(STUB_EMBEDDING_DIMENSION).fill(0))
  }
}
