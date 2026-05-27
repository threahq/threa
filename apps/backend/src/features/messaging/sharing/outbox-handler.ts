import type { Pool } from "pg"
import type { Server } from "socket.io"
import { isOutboxEventType, type OutboxEvent } from "../../../lib/outbox"
import { SharedMessageRepository } from "./repository"
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
 * `message:updated` is reserved for thread-reply-count bumps
 * (`event-service.ts:163`) and never carries a content/streamId delta, so
 * including it here would fan out `pointer:invalidated` to every target
 * stream of every shared parent on every reply — a pure cache-bust with
 * nothing to re-fetch.
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
  for (const share of shares) {
    let sources = sourcesByTarget.get(share.targetStreamId)
    if (!sources) {
      sources = new Set()
      sourcesByTarget.set(share.targetStreamId, sources)
    }
    sources.add(share.sourceMessageId)
  }
  for (const [targetStreamId, sources] of sourcesByTarget) {
    for (const sourceMessageId of sources) {
      io.to(`ws:${workspaceId}:stream:${targetStreamId}`).emit(POINTER_INVALIDATED_EVENT, {
        workspaceId,
        targetStreamId,
        sourceMessageId,
      })
    }
  }
}
