import type { Querier } from "../../../db"
import { ContextIntents, ContextRefKinds, type ContextIntent, type ContextRefKind } from "@threa/types"
import { HttpError } from "../../../lib/errors"
import { StreamRepository, checkStreamAccess } from "../../streams"
import { MessageRepository } from "../../messaging"
import { ConversationRepository } from "../../conversations"
import { logger } from "../../../lib/logger"
import { ContextBagRepository } from "./repository"
import { assertRefAccess } from "./registry"
import { DISCUSS_WINDOW_TOTAL } from "./resolvers/thread-resolver"
import { CONVERSATION_WINDOW_TOTAL } from "./resolvers/conversation-resolver"

export interface ContextRefSource {
  streamId: string
  displayName: string | null
  slug: string | null
  type: string
  itemCount: number
}

export interface EnrichedContextRef {
  kind: ContextRefKind
  streamId: string
  /** The conversation for `kind: "conversation"` refs; null for thread refs. */
  conversationId: string | null
  fromMessageId: string | null
  toMessageId: string | null
  /** Cosmetic deep-link anchor; resolver ignores it. */
  originMessageId: string | null
  source: ContextRefSource
}

export interface StreamContextBagResponse {
  bag: {
    id: string
    intent: ContextIntent
  } | null
  refs: EnrichedContextRef[]
}

export interface FetchStreamBagOptions {
  /**
   * Skip the per-stream access check. Set to true when the caller has
   * already validated stream access (e.g. the stream-bootstrap handler runs
   * `validateStreamAccess` before reaching this code) — avoids a duplicate
   * lookup.
   */
  skipAccessCheck?: boolean
}

/**
 * Fetch the persisted ContextBag for a stream with each ref enriched with
 * source-stream metadata. Shared between:
 *
 * - `GET /api/workspaces/:ws/streams/:id/context-bag` (the standalone HTTP
 *   handler, used by composer chip lookups)
 * - `GET /api/workspaces/:ws/streams/:id/bootstrap` (folds the bag into the
 *   stream bootstrap so the timeline message badge renders synchronously
 *   from cached data, no second fetch, no layout shift on first render)
 *
 * Returns `{bag: null, refs: []}` for streams without an attached bag.
 *
 * Access policy (INV-8):
 * - Caller must have stream access — verified via `checkStreamAccess`
 *   unless `skipAccessCheck` is set (bootstrap caller has already done it).
 * - Per-ref read access is always re-verified via `resolver.assertAccess`.
 *   A user who lost access to a source thread sees the bag minus that ref.
 */
export async function fetchStreamBag(
  db: Querier,
  params: {
    workspaceId: string
    streamId: string
    userId: string
  },
  options: FetchStreamBagOptions = {}
): Promise<StreamContextBagResponse> {
  const { workspaceId, streamId, userId } = params

  // Use the canonical access check rather than membership directly:
  // public channels grant read without `stream_members` rows, and threads
  // inherit access from their root stream — both cases that
  // `StreamMemberRepository.isMember` gets wrong. Bootstrap callers pass
  // `skipAccessCheck: true` because `validateStreamAccess` already ran.
  if (!options.skipAccessCheck) {
    const stream = await checkStreamAccess(db, streamId, workspaceId, userId)
    if (!stream) {
      throw new HttpError("No access to stream", { status: 403, code: "STREAM_FORBIDDEN" })
    }
  }

  const bag = await ContextBagRepository.findByStream(db, workspaceId, streamId)
  if (!bag) {
    return { bag: null, refs: [] }
  }

  // Per-ref access checks first. If a single ref is forbidden the bag should
  // still render with the rest — losing access to one source thread shouldn't
  // crash the whole bootstrap. Anything other than a clean FORBIDDEN bubbles
  // up so a real failure (DB error, programmer bug) still surfaces.
  const visibleRefs = (
    await Promise.all(
      bag.refs.map(async (ref) => {
        try {
          await assertRefAccess(db, ref, userId, workspaceId)
          return ref
        } catch (err) {
          if (err instanceof HttpError && err.status === 403) {
            logger.info(
              { workspaceId, streamId, refKind: ref.kind, refStreamId: ref.streamId, code: err.code },
              "context-bag: dropping ref the caller can no longer read"
            )
            return null
          }
          throw err
        }
      })
    )
  ).filter((r): r is (typeof bag.refs)[number] => r !== null)

  // Batch the source-stream lookups + per-stream message counts. The v1 max is
  // 10 refs but the old per-ref loop hit 2N+1 round-trips; one query per
  // dimension is the right ceiling regardless of N. INV-56.
  const refStreamIds = [...new Set(visibleRefs.map((r) => r.streamId))]
  const [sourceStreams, itemCounts] = await Promise.all([
    StreamRepository.findByIds(db, refStreamIds),
    MessageRepository.countByStreams(db, refStreamIds),
  ])
  const streamById = new Map(sourceStreams.map((s) => [s.id, s]))

  // A conversation ref's displayed count is its own member count (not the root
  // stream's total), so batch-load the referenced conversations up front.
  const conversationIds = [
    ...new Set(visibleRefs.flatMap((r) => (r.kind === ContextRefKinds.CONVERSATION ? [r.conversationId] : []))),
  ]
  const conversations = conversationIds.length
    ? await ConversationRepository.findByIds(db, workspaceId, conversationIds)
    : []
  const conversationById = new Map(conversations.map((c) => [c.id, c]))

  // For DISCUSS_THREAD, the resolver only sends ~DISCUSS_WINDOW_TOTAL messages
  // to the model regardless of how big the source is. Surfacing the raw total
  // in the context pill ("487 messages in #intro") is misleading because the AI
  // never sees more than the window — clamp the displayed count to what's
  // actually shared so the chip matches reality.
  const isWindowedIntent = bag.intent === ContextIntents.DISCUSS_THREAD

  const enriched: EnrichedContextRef[] = []
  for (const ref of visibleRefs) {
    const sourceStream = streamById.get(ref.streamId)
    if (!sourceStream) continue

    let itemCount: number
    let conversationId: string | null = null
    if (ref.kind === ContextRefKinds.CONVERSATION) {
      conversationId = ref.conversationId
      const memberCount = conversationById.get(ref.conversationId)?.messageIds.length ?? 0
      itemCount = isWindowedIntent ? Math.min(memberCount, CONVERSATION_WINDOW_TOTAL) : memberCount
    } else {
      const totalCount = itemCounts.get(ref.streamId) ?? 0
      itemCount = isWindowedIntent ? Math.min(totalCount, DISCUSS_WINDOW_TOTAL) : totalCount
    }

    enriched.push({
      kind: ref.kind,
      streamId: ref.streamId,
      conversationId,
      fromMessageId: ref.kind === ContextRefKinds.THREAD ? (ref.fromMessageId ?? null) : null,
      toMessageId: ref.kind === ContextRefKinds.THREAD ? (ref.toMessageId ?? null) : null,
      originMessageId: ref.originMessageId ?? null,
      source: {
        streamId: sourceStream.id,
        displayName: sourceStream.displayName ?? null,
        slug: sourceStream.slug ?? null,
        type: sourceStream.type,
        itemCount,
      },
    })
  }

  return {
    bag: { id: bag.id, intent: bag.intent },
    refs: enriched,
  }
}
