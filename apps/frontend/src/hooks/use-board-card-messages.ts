import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { db, type CachedEvent } from "@/db"
import type { RenderableMessage } from "@/components/message/message-item"
import type { AuthorType } from "@threa/types"
import type { BoardViewPost } from "./use-stable-board-view"

/** Mirrors the server board projection's trailing-reply cap (service.ts). */
const RECENT_PREVIEW_CAP = 3

interface MessageCreatedPayloadShape {
  messageId?: string
  contentMarkdown?: string
  reactions?: Record<string, string[]>
  attachments?: RenderableMessage["attachments"]
  linkPreviews?: RenderableMessage["linkPreviews"]
  deletedAt?: string | null
}

/** Project a `message_created` event row into the shared render shape the timeline
 *  and the board both use. Returns null for a non-message or soft-deleted row. */
function eventToRenderable(event: CachedEvent): RenderableMessage | null {
  const p = (event.payload ?? {}) as MessageCreatedPayloadShape
  if (!p.messageId || p.deletedAt) return null
  return {
    id: p.messageId,
    authorId: event.actorId ?? "",
    authorType: (event.actorType ?? "user") as AuthorType,
    contentMarkdown: p.contentMarkdown ?? "",
    reactions: p.reactions ?? {},
    createdAt: event.createdAt,
    attachments: p.attachments,
    linkPreviews: p.linkPreviews,
  }
}

export interface BoardCardMessages {
  /** The post's opening message — live from the events rail when synced, else the
   *  cached projection (a thread's parent opening lives in another stream). */
  openingMessage: RenderableMessage | null
  /** Replies present locally, chronological. From the events rail when the card's
   *  stream is synced; otherwise the cached server preview. */
  replies: RenderableMessage[]
  /** Total replies per the conversation aggregate; drives the "N more" gap and may
   *  exceed the locally-synced `replies` (older messages not yet in IDB). */
  totalReplies: number
  /** Where the bodies came from: the live `db.events` rail, or the cached server
   *  projection (a stream not yet synced into IDB — a cold/offline first open). */
  source: "events" | "projection"
}

/**
 * A board card's messages, read OFFLINE-FIRST from the same `db.events` store the
 * timeline rides — never blocking on the network. Live edits, reactions, and sends
 * fill in place because the events rail patches those rows; opening the board on a
 * spotty connection still renders instantly from whatever is in IDB.
 *
 * When the card's stream hasn't synced into IDB yet (a never-opened public channel
 * on a cold device), it falls back to the cached server projection on the
 * conversation row so the card always shows something immediately. The board
 * subscribing those streams (so their events flow in) is the coverage follow-up;
 * the fallback keeps the card correct until then.
 */
export function useBoardCardMessages(post: BoardViewPost): BoardCardMessages {
  const streamId = post.conversation.streamId
  const messageIds = post.conversation.messageIds
  const openingId = post.openingMessage?.id ?? null

  // Flat conversation: the opening is `messageIds[0]`, replies are the rest. A
  // thread's opening is the parent message (not a member), so every messageId is a
  // reply. Mirrors the server board projection (service.ts:listByWorkspace).
  const replyIds = useMemo(
    () => (openingId && openingId === messageIds[0] ? messageIds.slice(1) : messageIds),
    [openingId, messageIds]
  )

  // Reactive read of this conversation's primary messages from the events rail. A
  // primary membership always lives in the conversation's own stream, so one stream
  // scan covers every reply (and the opening when the conversation is flat). We
  // track raw message ids seen separately from the renderable map: a soft-deleted
  // message is a seen id with no renderable row, and the two must not be conflated.
  const liveData = useLiveQuery(async () => {
    const events = await db.events.where("[streamId+eventType]").equals([streamId, "message_created"]).toArray()
    const seenMessageIds = new Set<string>()
    const messages = new Map<string, RenderableMessage>()
    for (const event of events) {
      const payload = (event.payload ?? {}) as MessageCreatedPayloadShape
      if (payload.messageId) seenMessageIds.add(payload.messageId)
      const message = eventToRenderable(event)
      if (message) messages.set(message.id, message)
    }
    return { messages, seenMessageIds }
  }, [streamId])

  return useMemo(() => {
    // Recompute the count only when the opening relationship is known to be flat
    // (opening present at `messageIds[0]`). With a deleted opening (`openingId`
    // null) the slice is ambiguous — the server still excludes `messageIds[0]`
    // from its count — so trust the server's `post.totalReplies` rather than
    // miscount the missing opening as a reply.
    const totalReplies = openingId !== null && openingId === messageIds[0] ? messageIds.length - 1 : post.totalReplies
    const seen = liveData?.seenMessageIds

    // The rail "knows" this conversation once it has synced any of its message ids
    // — INCLUDING soft-deleted ones, which `eventToRenderable` drops from the
    // renderable map. Gate on raw presence, not renderable rows: a wholly-deleted
    // conversation must show its tombstones (nothing), not resurrect stale bodies
    // from the projection; a conversation whose ids simply aren't in the synced
    // window is genuinely unseen and keeps the cached preview.
    const openingSeen = !!(openingId && seen?.has(openingId))
    const conversationSeen = seen !== undefined && (openingSeen || replyIds.some((id) => seen.has(id)))

    let openingMessage: RenderableMessage | null
    if (openingSeen && openingId) openingMessage = liveData?.messages.get(openingId) ?? null
    else openingMessage = (post.openingMessage as RenderableMessage | null) ?? null

    if (conversationSeen) {
      const liveReplies: RenderableMessage[] = []
      for (const id of replyIds) {
        const message = liveData?.messages.get(id)
        if (message) liveReplies.push(message)
      }
      liveReplies.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      return { openingMessage, replies: liveReplies, totalReplies, source: "events" }
    }
    return {
      openingMessage,
      replies: post.recentMessages as RenderableMessage[],
      totalReplies,
      source: "projection",
    }
  }, [liveData, replyIds, openingId, messageIds, post])
}

export { RECENT_PREVIEW_CAP }
