import type { Querier } from "../../db"
import { MessageRepository, type Message } from "../messaging"
import { enrichMessagesWithLinkPreviews } from "../link-previews"
import { agentConversationSummaryId } from "../../lib/id"
import type { AI } from "@threahq/agent-runtime"
import {
  foldRollingSummary,
  ROLLING_SUMMARY_BATCH_SIZE,
  ROLLING_SUMMARY_MAX_BATCHES,
  type RollingSummaryMessage,
} from "@threahq/agent-runtime"
import { ConversationSummaryRepository } from "./conversation-summary-repository"
import { logger } from "../../lib/logger"

interface UpdateSummaryParams {
  db: Querier
  workspaceId: string
  streamId: string
  personaId: string
  keptMessages: Message[]
}

export interface ConversationSummaryServiceDeps {
  ai: AI
  modelId: string
  temperature: number
}

/**
 * Maintains rolling summaries for conversation segments dropped from active
 * context windows. The fold itself — prompt, bounds, per-message formatting — is
 * the shared `foldRollingSummary` (`@threahq/agent-runtime`) the in-enclave
 * summarizer runs too, so a summary built on either surface reads identically
 * (no drift, INV-35/37). This service owns only the plaintext orchestration: the
 * incremental cursor, batching, and the repository upsert.
 */
export class ConversationSummaryService {
  constructor(private readonly deps: ConversationSummaryServiceDeps) {}

  async updateForContext(params: UpdateSummaryParams): Promise<string | null> {
    const { db, workspaceId, streamId, personaId, keptMessages } = params
    if (keptMessages.length === 0) return null

    const oldestKeptSequence = keptMessages[0].sequence
    const existing = await ConversationSummaryRepository.findByStreamAndPersona(db, streamId, personaId)

    if (existing?.sealed) {
      // A sealed row is owned by the enclave/E2E path, which computes its rolling
      // summary in-enclave. The companion path must never overwrite it — that would
      // flip an E2E row to plaintext and destroy the sealed context. Unreachable by
      // construction today (a stream is E2E xor not, and the companion never runs on
      // E2E streams), so reaching it means that invariant broke: refuse loudly
      // rather than silently corrupt sealed data (INV-11).
      logger.error(
        { workspaceId, streamId, personaId },
        "Companion summary update found a sealed (E2E) summary row; refusing to overwrite"
      )
      return null
    }

    const olderMessages = await MessageRepository.list(db, streamId, {
      limit: 1,
      beforeSequence: oldestKeptSequence,
    })
    if (olderMessages.length === 0) {
      return existing?.summary ?? null
    }

    let cursor = existing ? existing.lastSummarizedSequence + 1n : 1n
    const maxSequenceToSummarize = oldestKeptSequence - 1n

    if (cursor > maxSequenceToSummarize) {
      return existing?.summary ?? null
    }

    let currentSummary = existing?.summary ?? ""
    let lastSummarizedSequence = existing?.lastSummarizedSequence ?? 0n
    const summaryRecordId = existing?.id ?? agentConversationSummaryId()
    let batchesProcessed = 0

    while (cursor <= maxSequenceToSummarize && batchesProcessed < ROLLING_SUMMARY_MAX_BATCHES) {
      const batch = await MessageRepository.listBySequenceRange(db, streamId, cursor, maxSequenceToSummarize, {
        limit: ROLLING_SUMMARY_BATCH_SIZE,
      })
      if (batch.length === 0) break

      const enrichedBatch = await enrichMessagesWithLinkPreviews(db, workspaceId, batch)
      try {
        currentSummary = await foldRollingSummary({
          ai: this.deps.ai,
          model: this.deps.ai.getLanguageModel(this.deps.modelId),
          modelString: this.deps.modelId,
          temperature: this.deps.temperature,
          existingSummary: currentSummary,
          newMessages: enrichedBatch.map(toSummaryMessage),
          telemetry: { functionId: "summary-update" },
          context: { workspaceId, origin: "system" },
        })
      } catch (err) {
        logger.warn(
          {
            err,
            workspaceId,
            streamId,
            personaId,
            cursor: cursor.toString(),
            maxSequenceToSummarize: maxSequenceToSummarize.toString(),
          },
          "Rolling conversation summary failed; continuing without summary update"
        )
        break
      }
      lastSummarizedSequence = batch[batch.length - 1].sequence

      await ConversationSummaryRepository.upsert(db, {
        id: summaryRecordId,
        workspaceId,
        streamId,
        personaId,
        summary: currentSummary,
        lastSummarizedSequence,
      })

      cursor = lastSummarizedSequence + 1n
      batchesProcessed++
    }

    return currentSummary || null
  }
}

function toSummaryMessage(message: Message): RollingSummaryMessage {
  return {
    sequence: message.sequence,
    authorLabel: `${message.authorType}:${message.authorId}`,
    content: message.contentMarkdown,
  }
}
