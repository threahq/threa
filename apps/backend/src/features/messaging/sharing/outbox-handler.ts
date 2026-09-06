import type { Pool } from "pg"
import type { Server } from "socket.io"
import type { SharedMessageRef } from "@threahq/types"
import { isOutboxEventType, type OutboxEvent } from "../../../lib/outbox"
import { collectSharedMessageRefs, hydrateSharedMessageRefsForRoom, toDualSlotMaps } from "./hydration"
import { SharedMessageRepository } from "./repository"
import { MessageRepository } from "../repository"
import { E2eStreamsRepository } from "../../e2e-streams"

/**
 * Event name emitted to target streams when a pointer-referenced source
 * message has been edited or deleted. The client uses it as a cache-bust hint
 * to re-fetch the hydrated pointer content. Lives on the realtime channel,
 * not the outbox — there's no persistent state change on the share row
 * itself (INV-4).
 */
export const POINTER_INVALIDATED_EVENT = "pointer:invalidated"

/**
 * Extract every source messageId from an outbox event that signals a source
 * change pointer consumers care about. Returns an empty array when the event
 * type is unrelated or the payload shape is unexpected.
 *
 * - `message:edited` / `message:deleted` carry one messageId.
 * - `messages:moved` carries N: a moved message's `streamId` changes, which
 *   changes what hydrated pointers' "open in source stream" link should
 *   target. Content/author/createdAt are unchanged, so the invalidation is
 *   purely a cache-bust hint to re-fetch the hydration payload.
 *
 * `thread:updated` carries thread-reply-count bumps and never a content/streamId
 * delta, so including it here would fan out `pointer:invalidated` to every target
 * stream of every shared parent on every reply — a pure cache-bust with nothing
 * to re-fetch. (It is not stream-message-scoped anyway, so it never reaches here.)
 */
function extractMessageIdsForInvalidation(event: OutboxEvent): string[] {
  if (isOutboxEventType(event, "message:edited")) {
    // event.payload.event is a StreamEvent whose inner `payload` is typed
    // as `unknown` (event-shape varies by event type). Narrow only that
    // field; the outer envelope is fully typed via isOutboxEventType.
    const inner = event.payload.event?.payload as { messageId?: string } | undefined
    return inner?.messageId ? [inner.messageId] : []
  }
  if (isOutboxEventType(event, "message:deleted")) {
    return event.payload.messageId ? [event.payload.messageId] : []
  }
  if (isOutboxEventType(event, "messages:moved")) {
    return event.payload.movedMessageIds
  }
  return []
}

function addTo(index: Map<string, Set<string>>, key: string, value: string): void {
  const existing = index.get(key)
  if (existing) existing.add(value)
  else index.set(key, new Set([value]))
}

/**
 * If the given outbox event signals a source message change, look up every
 * target stream that hosts a pointer to it and emit `pointer:invalidated`
 * to those streams' rooms so subscribed clients re-fetch the hydrated
 * content. No-op for event types that don't affect pointer renders.
 *
 * Called from `BroadcastHandler.processEvents` after the normal broadcast
 * so pointer consumers learn about edits without duplicating the source
 * message's own broadcast.
 */
export async function invalidatePointersForEvent(event: OutboxEvent, db: Pool, io: Server): Promise<void> {
  const sourceMessageIds = extractMessageIdsForInvalidation(event)
  if (sourceMessageIds.length === 0) return

  const { workspaceId, streamId } = event.payload as { workspaceId: string; streamId: string }

  // E2E streams: sharing from an E2E source is blocked at the handler layer,
  // so no pointer rows exist. Short-circuit before the share lookup.
  if (await E2eStreamsRepository.isE2eStream(db, workspaceId, streamId)) return

  const shares = await SharedMessageRepository.listBySourceMessageIds(db, workspaceId, sourceMessageIds)
  if (shares.length === 0) return

  // Group affected target streams by the source whose pointer they host so
  // each invalidation event names the specific source the client should
  // refetch. One emit per (targetStream, source) pair — clients subscribe
  // by stream, not by source, so collapsing across sources here would force
  // every pointer in the room to refetch on every per-source change.
  const sourcesByTarget = new Map<string, Set<string>>()
  const shareMessagesByTarget = new Map<string, Set<string>>()
  for (const share of shares) {
    addTo(sourcesByTarget, share.targetStreamId, share.sourceMessageId)
    addTo(shareMessagesByTarget, share.targetStreamId, share.shareMessageId)
  }

  // The room renders the references its OWN messages carry, so the slot keys
  // it looks up carry those messages' pins. Hydrating the bare source id
  // instead would emit `shared:<id>` entries no pinned node ever reads. One
  // batched read for every share-carrying message across all targets (INV-56);
  // a share row whose message is gone contributes no references.
  const shareMessages = await MessageRepository.findByIdsInWorkspace(db, workspaceId, [
    ...new Set(shares.map((share) => share.shareMessageId)),
  ])

  const refsByTarget = new Map<string, Map<string, SharedMessageRef>>()
  for (const [targetStreamId, shareMessageIds] of shareMessagesByTarget) {
    const invalidatedSources = sourcesByTarget.get(targetStreamId) ?? new Set<string>()
    const carried = new Map<string, SharedMessageRef>()
    for (const shareMessageId of shareMessageIds) {
      collectSharedMessageRefs(shareMessages.get(shareMessageId)?.contentJson, carried)
    }
    const refs = new Map<string, SharedMessageRef>()
    for (const [key, ref] of carried) {
      if (invalidatedSources.has(ref.messageId)) refs.set(key, ref)
    }
    refsByTarget.set(targetStreamId, refs)
  }

  // Per-target hydration is independent; run them concurrently so a source
  // shared into many streams doesn't serialize a DB round per target.
  // B4: emit the FULL per-target hydration map — the one hydration call also
  // resolves nested pointers, and discarding them would leave an inner card
  // skeleton until a REST replace when an edit ADDS a nested pointer.
  const hydratedByTarget = await Promise.all(
    [...sourcesByTarget.entries()].map(async ([targetStreamId, sources]) => ({
      targetStreamId,
      sources,
      dual: toDualSlotMaps(
        await hydrateSharedMessageRefsForRoom(
          db,
          workspaceId,
          targetStreamId,
          (refsByTarget.get(targetStreamId) ?? new Map()).values()
        )
      ),
    }))
  )
  for (const { targetStreamId, sources, dual } of hydratedByTarget) {
    for (const sourceMessageId of sources) {
      io.to(`ws:${workspaceId}:stream:${targetStreamId}`).emit(POINTER_INVALIDATED_EVENT, {
        workspaceId,
        targetStreamId,
        sourceMessageId,
        slots: dual.slots,
        sharedMessages: dual.sharedMessages,
      })
    }
  }
}
