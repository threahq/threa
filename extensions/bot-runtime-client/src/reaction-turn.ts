import { NO_RESPONSE_SENTINEL } from "./no-response"
import { isObject } from "./ws-hint"

interface ReactionEvent {
  action: "added" | "removed"
  emoji: string
  reactorId: string
  reactorName: string | null
}

const MAX_QUOTE_CHARS = 500

function isReactionEvent(value: unknown): value is ReactionEvent {
  return (
    isObject(value) &&
    (value.action === "added" || value.action === "removed") &&
    typeof value.emoji === "string" &&
    value.emoji.length > 0 &&
    typeof value.reactorId === "string" &&
    value.reactorId.length > 0 &&
    (typeof value.reactorName === "string" || value.reactorName === null)
  )
}

function parseReactionEvents(metadata: unknown): ReactionEvent[] | null {
  if (!isObject(metadata) || !isObject(metadata.reaction)) return null
  const { events } = metadata.reaction
  if (!Array.isArray(events) || events.length === 0 || !events.every(isReactionEvent)) return null
  return events
}

function quote(markdown: string): string {
  const trimmed = markdown.trim()
  const excerpt = trimmed.length > MAX_QUOTE_CHARS ? `${trimmed.slice(0, MAX_QUOTE_CHARS).trimEnd()}…` : trimmed
  return (excerpt || "(empty message)")
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n")
}

/**
 * The turn prompt for a reaction claim: one line per event, the reacted message's excerpt, and how to stay silent.
 * Emoji arrive as wire shortcodes (`:tada:`) or unicode and render as given. Null when the claim's metadata is malformed.
 */
export function reactionTurnPrompt(invocation: {
  metadata: unknown
  sourceMessageId: string
  promptMarkdown: string
}): string | null {
  const events = parseReactionEvents(invocation.metadata)
  if (!events) return null
  const lines = events.map((event) => {
    const who = event.reactorName?.trim() || "Someone"
    return event.action === "added"
      ? `${who} reacted ${event.emoji} to your message ${invocation.sourceMessageId}.`
      : `${who} removed their ${event.emoji} reaction from your message ${invocation.sourceMessageId}.`
  })
  return [
    ...lines,
    "",
    "Your message:",
    quote(invocation.promptMarkdown),
    "",
    `This is a reaction, not a message. Reply only if it calls for one. To stay silent, reply exactly ${NO_RESPONSE_SENTINEL}.`,
  ].join("\n")
}
