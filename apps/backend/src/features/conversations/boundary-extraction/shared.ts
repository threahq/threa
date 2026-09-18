import { StreamTypes } from "@threahq/types"
import type { ExtractionContext, ExtractionResult } from "./types"
import type { Message } from "../../messaging"

/**
 * Age of `date` relative to `reference` (the new message), rendered for the
 * prompt: "just now", "5m ago", "3h ago", "2d ago". Ages at or after the
 * reference clamp to "just now" — `recentMessages` includes a couple of
 * messages sent AFTER the new message (MESSAGES_AFTER), and their sub-minute
 * skew carries no boundary signal.
 */
export function formatRelativeAge(date: Date, reference: Date): string {
  const minutes = Math.floor((reference.getTime() - date.getTime()) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  // Hours up to two days: "26h ago" carries the overnight-vs-full-day nuance
  // that "1d ago" would flatten, and that nuance is exactly what the model
  // weighs at session boundaries.
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * A thread whose first message has nothing to be classified against: no active
 * conversation and no conversation on the parent message. Every extractor
 * answers this the same way, without a model call.
 */
export function isColdStartThread(context: ExtractionContext): boolean {
  return (
    context.streamType === StreamTypes.THREAD &&
    context.activeConversations.length === 0 &&
    (context.parentMessageConversations?.length ?? 0) === 0
  )
}

export function coldStartThreadResult(context: ExtractionContext): ExtractionResult {
  return {
    assignments: [{ conversationId: null, isPrimary: true }],
    newConversationTopic: truncateAsTopic(context.newMessage),
    confidence: 1.0,
  }
}

/** The message's own opening, used as a topic when no model wrote one. */
export function truncateAsTopic(message: Message): string {
  const firstSentence = message.contentMarkdown.split(/[.!?\n]/)[0]?.trim()
  const text = firstSentence && firstSentence.length > 0 ? firstSentence : message.contentMarkdown.trim()

  if (text.length <= 100) {
    return text
  }

  // Find last space before the limit to avoid cutting mid-word.
  const lastSpace = text.lastIndexOf(" ", 99)
  if (lastSpace > 20) {
    return text.slice(0, lastSpace) + "…"
  }

  return text.slice(0, 99) + "…"
}
