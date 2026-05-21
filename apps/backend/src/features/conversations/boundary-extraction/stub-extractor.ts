import type { BoundaryExtractor, ExtractionContext, ExtractionResult } from "./types"
import { logger } from "../../../lib/logger"
import { StreamTypes } from "@threa/types"

/**
 * Stub boundary extractor for CI/test environments where the LLM API is not available.
 *
 * - Threads with an existing conversation: join it as primary.
 * - Threads with only a parent conversation: join the parent as primary.
 * - Everything else: create a new conversation.
 *
 * Does not emit reassignments (no LLM judgement available).
 */
export class StubBoundaryExtractor implements BoundaryExtractor {
  async extract(context: ExtractionContext): Promise<ExtractionResult> {
    logger.debug({ messageId: context.newMessage.id }, "Using stub boundary extractor")

    if (context.streamType === StreamTypes.THREAD) {
      const existingConv = context.activeConversations[0]
      if (existingConv) {
        return {
          assignments: [{ conversationId: existingConv.id, isPrimary: true }],
          confidence: 1.0,
        }
      }

      const parentConv = context.parentMessageConversations?.[0]
      if (parentConv) {
        return {
          assignments: [{ conversationId: parentConv.id, isPrimary: true }],
          confidence: 1.0,
        }
      }
    }

    return {
      assignments: [{ conversationId: null, isPrimary: true }],
      newConversationTopic: this.extractTopic(context.newMessage.contentMarkdown),
      confidence: 1.0,
    }
  }

  private extractTopic(content: string): string {
    const firstSentence = content.split(/[.!?\n]/)[0]?.trim()
    const text = firstSentence && firstSentence.length > 0 ? firstSentence : content.trim()

    if (text.length <= 100) {
      return text
    }

    const lastSpace = text.lastIndexOf(" ", 99)
    if (lastSpace > 20) {
      return text.slice(0, lastSpace) + "…"
    }

    return text.slice(0, 99) + "…"
  }
}
