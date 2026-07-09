import { ulid } from "ulid"

/**
 * Client-mint a conversation id (`conv_` ULID, INV-2 — same shape as the
 * backend's `conversationId()`). A board post mints its conversation id up front
 * so it can slot the card the instant the composer clears, then have the send
 * honor the same id (the `{ intent: "new", conversationId }` directive) — the
 * card reconciles by that one id when the echo lands, no temp-id swap. Idempotent
 * on the wire: the send dedupes on `clientMessageId` before the assigner runs, so
 * a retried send inserts the conversation exactly once.
 */
export function generateConversationId(): string {
  return `conv_${ulid()}`
}
