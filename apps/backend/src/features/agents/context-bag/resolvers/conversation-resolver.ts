import { ContextRefKinds, type ConversationContextRef } from "@threa/types"
import { HttpError } from "../../../../lib/errors"
import { MessageRepository } from "../../../messaging"
import { ConversationRepository } from "../../../conversations"
import { checkStreamAccess } from "../../../streams"
import { hydrateRenderableItems } from "../renderable-items"
import type { Resolver } from "../types"

/**
 * Total conversation member messages we include as context. A conversation is
 * an AI-clustered topic, usually far smaller than this, but a long-running one
 * (a channel discussion continued in a thread over days) can grow unbounded —
 * cap it around the focal so the model reads the topic without drowning. Mirrors
 * `DISCUSS_WINDOW_TOTAL` in the thread resolver.
 *
 * Exported so `fetchStreamBag` can clamp the displayed member count to what the
 * model actually sees.
 */
export const CONVERSATION_WINDOW_TOTAL = 50

/**
 * Conversation resolver: materializes a conversation's PRIMARY member messages
 * — flattened-chronological across its root stream and any threads (one root)
 * — into the inputs manifest + renderable messages.
 *
 * Unlike the thread resolver (which windows a whole stream), this resolves the
 * conversation's specific `message_ids`, so Ariadne sees the topic and none of
 * the surrounding channel chatter.
 *
 * Access check: the user must be able to read the conversation's root stream.
 * Per the one-root invariant, a single root check gates every member message
 * regardless of which thread it lives in.
 */
export const ConversationResolver: Resolver<ConversationContextRef> = {
  kind: ContextRefKinds.CONVERSATION,

  canonicalKey(ref) {
    return `conversation:${ref.conversationId}`
  },

  async assertAccess(db, ref, userId, workspaceId) {
    // Workspace-scoped load so a cross-tenant id can't confirm existence.
    const [conversation] = await ConversationRepository.findByIds(db, workspaceId, [ref.conversationId])
    if (!conversation) {
      throw new HttpError("No access to context source conversation", {
        status: 403,
        code: "CONTEXT_SOURCE_FORBIDDEN",
      })
    }
    // Single root check — thread membership is participation, not access
    // (INV-62). The authoritative root is the conversation's own stream, never
    // the client-supplied `ref.streamId`.
    const stream = await checkStreamAccess(db, conversation.streamId, workspaceId, userId)
    if (!stream) {
      throw new HttpError("No access to context source conversation", {
        status: 403,
        code: "CONTEXT_SOURCE_FORBIDDEN",
      })
    }
  },

  async fetch(db, ref) {
    const conversation = await ConversationRepository.findById(db, ref.conversationId)
    if (!conversation) {
      throw new HttpError("Context source conversation not found", {
        status: 404,
        code: "CONTEXT_SOURCE_NOT_FOUND",
      })
    }

    // `message_ids` can grow unbounded on a long-lived conversation, but only
    // CONVERSATION_WINDOW_TOTAL are ever rendered. Pre-slice by id BEFORE the DB
    // fetch so we don't pull (and discard) the whole history on every resolve:
    // prefixed ULID ids sort lexicographically by creation time (shared prefix),
    // so this is ~the chronological window. The 2x slack absorbs soft-deleted
    // rows that drop out after the fetch; the authoritative createdAt sort +
    // re-window below still fix exact order and size.
    const orderedIds = [...conversation.messageIds].sort()
    const focalIdIdx = ref.originMessageId ? orderedIds.indexOf(ref.originMessageId) : -1
    const candidateIds = windowAround(orderedIds, focalIdIdx, CONVERSATION_WINDOW_TOTAL * 2)

    // Member messages can span the root + its threads. Fetch them workspace-
    // scoped (derive the workspace from the loaded row — `fetch` has no
    // workspaceId), drop soft-deleted rows, and order by wall-clock time since
    // per-stream `sequence` is not comparable across streams.
    const byId = await MessageRepository.findByIdsInWorkspace(db, conversation.workspaceId, candidateIds)
    const ordered = [...byId.values()]
      .filter((m) => m.deletedAt === null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))

    const focalIdx = ref.originMessageId ? ordered.findIndex((m) => m.id === ref.originMessageId) : -1
    const windowed = windowAround(ordered, focalIdx, CONVERSATION_WINDOW_TOTAL)

    const hydrated = await hydrateRenderableItems(db, conversation.workspaceId, windowed)
    const tail = hydrated.items[hydrated.items.length - 1]
    const focalMessageId =
      ref.originMessageId && windowed.some((m) => m.id === ref.originMessageId) ? ref.originMessageId : null

    return {
      ...hydrated,
      tailMessageId: tail?.messageId ?? null,
      focalMessageId,
      viewport: null,
      // Enrich the chip from the conversation's OWN root, never the client-
      // supplied `ref.streamId` (which access-checks nothing) — otherwise an
      // arbitrary/cross-workspace stream's metadata would leak (INV-8).
      sourceStreamId: conversation.streamId,
    }
  },
}

/**
 * Clamp an already-sorted (chronological) list to `total` messages, centered on
 * the focal when one is present so the lead-up and the follow-up both survive.
 * Rebalances leftover capacity onto the long side so the window stays full-size
 * whenever the list allows. No focal → keep the most recent `total`.
 */
function windowAround<T>(ordered: T[], focalIdx: number, total: number): T[] {
  if (ordered.length <= total) return ordered
  if (focalIdx < 0) return ordered.slice(ordered.length - total)

  const beforeAvailable = focalIdx
  const afterAvailable = ordered.length - 1 - focalIdx
  const halfBefore = Math.floor((total - 1) / 2)
  const halfAfter = total - 1 - halfBefore

  let takeBefore = Math.min(beforeAvailable, halfBefore)
  let takeAfter = Math.min(afterAvailable, halfAfter)
  const remaining = total - 1 - takeBefore - takeAfter
  if (remaining > 0) {
    const extraAfter = Math.min(remaining, afterAvailable - takeAfter)
    takeAfter += extraAfter
    const extraBefore = Math.min(remaining - extraAfter, beforeAvailable - takeBefore)
    takeBefore += extraBefore
  }

  return ordered.slice(focalIdx - takeBefore, focalIdx + takeAfter + 1)
}
