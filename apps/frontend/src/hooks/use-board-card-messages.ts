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
  // scan covers every reply (and the opening when the conversation is flat).
  const liveById = useLiveQuery(async () => {
    const events = await db.events.where("[streamId+eventType]").equals([streamId, "message_created"]).toArray()
    const map = new Map<string, RenderableMessage>()
    for (const event of events) {
      const message = eventToRenderable(event)
      if (message) map.set(message.id, message)
    }
    return map
  }, [streamId])

  return useMemo(() => {
    const totalReplies = replyIds.length
    const liveOpening = openingId ? (liveById?.get(openingId) ?? null) : null
    const openingMessage = liveOpening ?? (post.openingMessage as RenderableMessage | null) ?? null

    const liveReplies: RenderableMessage[] = []
    if (liveById) {
      for (const id of replyIds) {
        const message = liveById.get(id)
        if (message) liveReplies.push(message)
      }
      liveReplies.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    }

    // Prefer the rail once it carries this conversation's content (any reply, or a
    // resolved read of a reply-less conversation). Fall back to the cached preview
    // while the stream is absent from IDB — the offline/cold first open.
    const railHasContent = liveById !== undefined && (liveReplies.length > 0 || replyIds.length === 0)
    if (railHasContent) {
      return { openingMessage, replies: liveReplies, totalReplies, source: "events" }
    }
    return {
      openingMessage,
      replies: post.recentMessages as RenderableMessage[],
      totalReplies,
      source: "projection",
    }
  }, [liveById, replyIds, openingId, post])
}

export { RECENT_PREVIEW_CAP }
