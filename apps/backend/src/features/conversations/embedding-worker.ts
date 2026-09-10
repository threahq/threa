import type { Pool } from "pg"
import type { ConversationEmbeddingJobData, JobHandler } from "../../lib/queue"
import { logger } from "../../lib/logger"
import { E2eStreamsRepository } from "../e2e-streams"
import { writeEmbeddingWithSourceHashGuard, type EmbeddingServiceLike } from "../memos"
import { ConversationRepository } from "./repository"
import { isConversationEmbeddable, loadConversationEmbeddingTexts } from "./embedding-text"

export interface ConversationEmbeddingWorkerDeps {
  pool: Pool
  embeddingService: EmbeddingServiceLike
}

/**
 * Three phases (INV-41): read the conversation and its opener, embed with no
 * connection held, write back under a CAS on the source hash observed before
 * embedding (INV-20).
 */
export function createConversationEmbeddingWorker(
  deps: ConversationEmbeddingWorkerDeps
): JobHandler<ConversationEmbeddingJobData> {
  const { pool, embeddingService } = deps

  return async (job) => {
    const { conversationId, workspaceId } = job.data
    const log = logger.child({ jobId: job.id, conversationId, workspaceId })

    const conversation = await ConversationRepository.findById(pool, conversationId)
    if (!conversation) {
      log.warn("Conversation not found, skipping embedding")
      return
    }
    if (conversation.workspaceId !== workspaceId) {
      log.error({ conversationWorkspaceId: conversation.workspaceId }, "Workspace mismatch on embedding job")
      return
    }
    if (!isConversationEmbeddable(conversation)) {
      log.debug("Conversation has no summary text yet, skipping embedding")
      return
    }
    if (await E2eStreamsRepository.isE2eStream(pool, workspaceId, conversation.streamId)) {
      return
    }

    const outcome = await writeEmbeddingWithSourceHashGuard({
      subject: conversationId,
      // Re-read rather than reuse the row above: the guard calls this again
      // after losing the write race, and the winner is exactly what changed.
      loadText: async () => {
        const current = await ConversationRepository.findById(pool, conversationId)
        if (!current || !isConversationEmbeddable(current)) return null
        return (await loadConversationEmbeddingTexts(pool, [current])).get(conversationId) ?? null
      },
      readExpectedHash: async () =>
        (await ConversationRepository.findEmbeddingSourceHashes(pool, workspaceId, [conversationId])).get(
          conversationId
        ) ?? null,
      embed: (text) => embeddingService.embed(text, { workspaceId, functionId: "conversation-embedding" }),
      write: (row) => ConversationRepository.updateEmbeddings(pool, workspaceId, [{ id: conversationId, ...row }]),
    })

    if (outcome === "written") log.info("Conversation embedding stored")
  }
}
