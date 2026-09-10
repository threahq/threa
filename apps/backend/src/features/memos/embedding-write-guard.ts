import { createHash } from "node:crypto"
import { logger } from "../../lib/logger"

const EMBED_WRITE_ATTEMPTS = 3

export function hashEmbeddingText(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

export type EmbeddingWriteOutcome = "written" | "text-missing" | "unchanged"

export interface EmbeddingWriteGuard {
  /** Names the row in the exhaustion error and the retry logs. */
  subject: string
  loadText: () => Promise<string | null>
  readExpectedHash: () => Promise<string | null>
  embed: (text: string) => Promise<number[]>
  write: (row: { embedding: number[]; sourceHash: string; expectedSourceHash: string | null }) => Promise<number>
}

/**
 * A row is embedded twice in quick succession (once when it is written, again
 * once conversation context lands), so losing the CAS on the source hash to the
 * other job is the common case, not an anomaly. The loser re-reads the text and
 * the stored hash and reuses its embedding when the text has not moved; only a
 * guard that keeps losing is handed back to the queue.
 */
export async function writeEmbeddingWithSourceHashGuard(guard: EmbeddingWriteGuard): Promise<EmbeddingWriteOutcome> {
  let embedded: { sourceHash: string; embedding: number[] } | null = null

  for (let attempt = 1; attempt <= EMBED_WRITE_ATTEMPTS; attempt++) {
    const text = await guard.loadText()
    if (text === null) return "text-missing"

    const sourceHash = hashEmbeddingText(text)
    const expectedSourceHash = await guard.readExpectedHash()
    if (expectedSourceHash === sourceHash) return "unchanged"

    if (embedded === null || embedded.sourceHash !== sourceHash) {
      embedded = { sourceHash, embedding: await guard.embed(text) }
    }
    const { embedding } = embedded

    const written = await guard.write({ embedding, sourceHash, expectedSourceHash })
    if (written > 0) return "written"

    logger.debug({ subject: guard.subject, attempt }, "Embedding lost to a concurrent write; re-reading the text")
  }

  throw new Error(`Embedding for ${guard.subject} lost to a concurrent write ${EMBED_WRITE_ATTEMPTS} times`)
}
