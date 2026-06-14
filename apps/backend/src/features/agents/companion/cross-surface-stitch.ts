import type { Querier } from "../../../db"
import { ConversationStatuses, StreamTypes } from "@threa/types"
import type { Stream } from "../../streams"
import { MessageRepository, type Message } from "../../messaging"
import type { Conversation } from "../../conversations"
import { formatTime, type TemporalContext } from "../../../lib/temporal"
import { trimToCharBudget } from "../context-builder"
import { resolveEligibleConversation } from "./conversation-highlight"

/**
 * Cross-surface episode continuity (agent-runtimes §2.8 Q8 follow-up): when a
 * persona is pulled from a channel discussion into a spawned thread, the thread
 * context otherwise collapses to the single spawning message and the
 * surrounding discussion is lost — one conversation lives across two streams
 * with two episode keys, which the per-stream window can't stitch on its own.
 *
 * This surfaces the spawning conversation's own messages as background context
 * so the persona keeps what it was pulled from. Decisions:
 * - Stitch depth = conversation membership: the segmenter's PRIMARY membership
 *   for the spawning conversation IS the discussion (not a blunt contiguous
 *   channel window), so unrelated channel cross-talk doesn't leak in.
 * - Anchoring = the spawning message's own conversation, with a recency
 *   fallback to the most recently active conversation overlapping the parent
 *   stream's recent window (the spawning @-mention is sometimes still
 *   unclassified, but the earlier discussion that pulled the persona in usually
 *   is). Shared with the in-stream highlight via `resolveEligibleConversation`.
 * - Budget = priority fill, not a fixed carve: the caller passes whatever the
 *   thread's own window left of the char budget, so the stitch is generous on a
 *   fresh thread (the moment continuity matters most) and fades to nothing once
 *   the thread is deep enough to carry its own context.
 *
 * Best-effort, never awaited, plaintext-only by construction (the segmenter
 * short-circuits E2E, so the conversation lookups return nothing there).
 */

export interface CrossSurfaceStitch {
  /**
   * The spawning conversation's member messages in chronological order, trimmed
   * newest-first to the budget. The spawning message itself is excluded — it is
   * already the thread's pinned anchor in `conversationHistory`.
   */
  messages: Message[]
  /** The spawning conversation's topic summary, for orientation (may be null). */
  topic: string | null
}

/** Recent parent-stream messages scanned for the recency fallback's window. */
const FALLBACK_WINDOW_MESSAGES = 20

/** Eligible to stitch while unresolved and carrying member messages to surface. */
function hasMembers(conversation: Conversation): boolean {
  return conversation.status !== ConversationStatuses.RESOLVED && conversation.messageIds.length > 0
}

export async function loadCrossSurfaceStitch(
  db: Querier,
  params: { workspaceId: string; thread: Stream; maxChars: number }
): Promise<CrossSurfaceStitch | null> {
  const { workspaceId, thread, maxChars } = params

  // Only a thread spawned from a message has a parent discussion to stitch, and
  // a non-positive budget means the thread's own window already filled it.
  if (thread.type !== StreamTypes.THREAD || !thread.parentMessageId || maxChars <= 0) return null

  // The spawning message lives in the parent stream — the bridge into the
  // discussion this thread was pulled from. `findThreadRoot` filters soft-deleted
  // roots and returns null for non-threads.
  const spawningMessage = await MessageRepository.findThreadRoot(db, thread)
  if (!spawningMessage) return null

  // Recency-fallback window: the parent stream's most recent messages, scanned
  // only when the spawning message's own conversation isn't eligible.
  const recent = await MessageRepository.list(db, spawningMessage.streamId, { limit: FALLBACK_WINDOW_MESSAGES })
  const conversation = await resolveEligibleConversation(db, {
    workspaceId,
    preferMessageId: spawningMessage.id,
    windowMessageIds: recent.map((m) => m.id),
    isEligible: hasMembers,
  })
  if (!conversation) return null

  // The conversation's PRIMARY membership is the discussion. Drop the spawning
  // message (already the thread's anchor) so it isn't duplicated.
  const memberIds = conversation.messageIds.filter((id) => id !== spawningMessage.id)
  if (memberIds.length === 0) return null

  const byId = await MessageRepository.findByIdsInWorkspace(db, workspaceId, memberIds)
  const members = memberIds
    .map((id) => byId.get(id))
    .filter((m): m is Message => m !== undefined && !m.deletedAt)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
  if (members.length === 0) return null

  // Fill the remaining budget newest-first so an oversized discussion keeps the
  // messages closest to the spawn point (most relevant to why the thread exists).
  const kept = trimToCharBudget(members, maxChars)
  return { messages: kept, topic: conversation.topicSummary?.trim() || null }
}

/**
 * Render the stitched discussion as a background block for the system prompt.
 * Plain `Author (time): content` lines — deliberately no `[msg:…]` pointer tags:
 * these are cross-stream background, and the prompt surfaces a single (thread)
 * stream id for pointer URLs, so tagging channel messages here would invite
 * wrong-stream pointers. The persona reaches channel messages precisely through
 * its workspace tools, not by quoting this block.
 */
export function formatSpawnedFromContext(
  stitch: CrossSurfaceStitch,
  authorNames: Map<string, string>,
  temporal: TemporalContext | undefined
): string {
  const lines: string[] = []
  if (stitch.topic) {
    lines.push(`Topic: ${stitch.topic}`, "")
  }
  for (const message of stitch.messages) {
    const author = authorNames.get(message.authorId) ?? "Unknown"
    const time = temporal ? ` (${formatTime(message.createdAt, temporal.timezone, temporal.timeFormat)})` : ""
    lines.push(`${author}${time}: ${message.contentMarkdown}`)
  }
  return lines.join("\n")
}
