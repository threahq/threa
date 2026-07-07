import type { BoundaryExtractor, ExtractionContext, ExtractionResult, SplitContext, SplitProposal } from "./types"
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

  /**
   * Deterministic stand-in for the batch split: halve a conversation of ≥4
   * messages into two groups, otherwise leave it whole (one group). No language
   * judgement — just enough structure for the propose/apply flow to be tested.
   */
  async splitConversation(context: SplitContext): Promise<SplitProposal> {
    logger.debug({ conversationId: context.conversationId }, "Using stub boundary extractor for split")
    const ids = context.messages.map((m) => m.id)
    if (ids.length < 4) {
      return {
        groups: [{ title: context.topicSummary ?? "Conversation", messageIds: ids }],
        confidence: 1.0,
        reasoning: "Too short to split (stub).",
      }
    }
    const mid = Math.ceil(ids.length / 2)
    return {
      groups: [
        { title: context.topicSummary ?? "First topic", messageIds: ids.slice(0, mid) },
        { title: "Second topic", messageIds: ids.slice(mid) },
      ],
      confidence: 1.0,
      reasoning: "Stub even split.",
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
