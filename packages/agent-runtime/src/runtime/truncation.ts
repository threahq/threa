import type { ModelMessage } from "ai"
import { logger } from "../logger"

/**
 * Maximum context size in characters for messages sent to the model.
 * This is a conservative limit to stay well under the 200k token limit.
 * Roughly 4 chars per token, so 400k chars ≈ 100k tokens.
 */
export const MAX_MESSAGE_CHARS = 400_000

/**
 * Maximum size for any single message in characters.
 * Individual messages larger than this will be truncated.
 * This prevents a single huge message from consuming all context.
 */
const MAX_SINGLE_MESSAGE_CHARS = 50_000

/**
 * Get the character length of a ModelMessage's content.
 */
function getMessageLength(message: ModelMessage): number {
  if (message.role === "tool") {
    // Tool messages have ToolContent = Array<ToolResultPart>
    // Each ToolResultPart has output: { type: 'text' | 'json', value: string | JSONValue }
    return message.content.reduce((sum, part) => {
      if (part.type === "tool-result") {
        if (part.output.type === "text") return sum + part.output.value.length
        return sum + JSON.stringify(part.output.value).length
      }
      return sum
    }, 0)
  }

  const content = "content" in message ? message.content : ""
  if (typeof content === "string") return content.length
  if (Array.isArray(content)) {
    return content.reduce((sum: number, part) => {
      if ("text" in part && typeof part.text === "string") return sum + part.text.length
      return sum
    }, 0)
  }
  return 0
}

/**
 * Truncate a single message's content if it exceeds the limit.
 * Returns a new message with truncated content, or the original if no truncation needed.
 */
function truncateSingleMessage(message: ModelMessage, maxChars: number): ModelMessage {
  const length = getMessageLength(message)
  if (length <= maxChars) return message

  logger.warn({ messageLength: length, maxChars, role: message.role }, "Truncating oversized message")

  if (message.role === "tool") {
    // For tool messages, truncate each tool-result part's output
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type === "tool-result") {
          const resultStr = part.output.type === "text" ? part.output.value : JSON.stringify(part.output.value)
          if (resultStr.length > maxChars) {
            return {
              ...part,
              output: {
                type: "text" as const,
                value: resultStr.slice(0, maxChars) + "\n\n[... content truncated due to length ...]",
              },
            }
          }
        }
        return part
      }),
    }
  }

  const content = "content" in message ? message.content : ""

  if (typeof content === "string") {
    const truncated = content.slice(0, maxChars) + "\n\n[... content truncated due to length ...]"
    return { ...message, content: truncated } as ModelMessage
  }

  if (Array.isArray(content)) {
    let remainingChars = maxChars
    const truncatedParts = []

    for (const part of content) {
      if ("text" in part && typeof part.text === "string") {
        if (part.text.length <= remainingChars) {
          truncatedParts.push(part)
          remainingChars -= part.text.length
        } else {
          truncatedParts.push({
            ...part,
            text: part.text.slice(0, remainingChars) + "\n\n[... content truncated ...]",
          })
          remainingChars = 0
        }
      } else {
        // Keep non-text parts (images, etc.)
        truncatedParts.push(part)
      }
      if (remainingChars === 0) break
    }

    return { ...message, content: truncatedParts } as ModelMessage
  }

  return message
}

/**
 * Truncate messages to stay within context limits.
 * Keeps recent messages, preserving tool call/response pairs.
 *
 * Strategy:
 * 1. First, truncate any individual messages that are too large
 * 2. Calculate total length of all messages
 * 3. If under limit, return all messages
 * 4. Otherwise, keep the most recent messages that fit
 * 5. Always keep at least the last message for context
 */
export function truncateMessages(messages: ModelMessage[], maxChars: number): ModelMessage[] {
  if (messages.length === 0) return messages

  // First pass: truncate any oversized individual messages
  const truncatedIndividual = messages.map((msg) => truncateSingleMessage(msg, MAX_SINGLE_MESSAGE_CHARS))

  // Calculate total length after individual truncation
  let totalLength = 0
  for (const msg of truncatedIndividual) {
    totalLength += getMessageLength(msg)
  }

  // If under limit, return all (after individual truncation)
  if (totalLength <= maxChars) return truncatedIndividual

  logger.warn(
    { totalLength, maxChars, messageCount: truncatedIndividual.length },
    "Truncating messages to stay within context limit"
  )

  // Build from the end, keeping messages until we hit the limit
  const kept: ModelMessage[] = []
  let keptLength = 0

  // Walk backwards through messages
  for (let i = truncatedIndividual.length - 1; i >= 0; i--) {
    const msg = truncatedIndividual[i]
    const msgLength = getMessageLength(msg)

    // If adding this message would exceed limit, stop
    // But always keep at least 1 message
    if (keptLength + msgLength > maxChars && kept.length > 0) {
      break
    }

    kept.unshift(msg)
    keptLength += msgLength
  }

  logger.info(
    { keptLength, keptCount: kept.length, droppedCount: truncatedIndividual.length - kept.length },
    "Messages truncated"
  )

  return kept
}
