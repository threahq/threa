import type { Pool } from "pg"
import type { ConversationEmbeddingJobData, JobHandler } from "../../lib/queue"
import { logger } from "../../lib/logger"
import { E2eStreamsRepository } from "../e2e-streams"
import type { EmbeddingServiceLike } from "../memos"
import { ConversationRepository } from "./repository"
import {
  hashConversationEmbeddingText,
  isConversationEmbeddable,
  loadConversationEmbeddingTexts,
} from "./embedding-text"

export interface ConversationEmbeddingWorkerDeps {
  pool: Pool
  embeddingService: EmbeddingServiceLike
}

/**
 * Three phases (INV-41): read the conversation and its opener, embed with no
 * connection held, write back. The write is guarded on the source hash, so a
 * concurrent re-extraction that already stored newer text wins (INV-20).
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

    const text = (await loadConversationEmbeddingTexts(pool, [conversation])).get(conversation.id) ?? ""
    const sourceHash = hashConversationEmbeddingText(text)
    const storedHashes = await ConversationRepository.findEmbeddingSourceHashes(pool, workspaceId, [conversation.id])
    if (storedHashes.get(conversation.id) === sourceHash) {
      log.debug("Embedding text unchanged, skipping")
      return
    }

    const embedding = await embeddingService.embed(text, { workspaceId, functionId: "conversation-embedding" })

    const written = await ConversationRepository.updateEmbeddings(pool, workspaceId, [
      { id: conversation.id, embedding, sourceHash },
    ])
    if (written === 0) {
      log.info("Conversation changed between fetch and write, embedding discarded")
      return
    }
    log.info("Conversation embedding stored")
  }
}
