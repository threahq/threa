import { useCallback, useMemo, useSyncExternalStore } from "react"
import { liveQuery, type Subscription } from "dexie"
import { db, type CachedEvent } from "@/db"
import type { RenderableMessage } from "@/components/message/message-item"
import type { AuthorType } from "@threa/types"
import type { BoardViewPost } from "./use-stable-board-view"

interface MessageCreatedPayloadShape {
  messageId?: string
  contentMarkdown?: string
  reactions?: Record<string, string[]>
  attachments?: RenderableMessage["attachments"]
  linkPreviews?: RenderableMessage["linkPreviews"]
  deletedAt?: string | null
  /** Set only on an optimistic board reply, naming the conversation it attaches
   *  to so a card can surface the pending row before the server echo lands. */
  conversationId?: string
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

interface StreamRail {
  /** Renderable (non-deleted) message_created rows for the stream, by message id. */
  messages: Map<string, RenderableMessage>
  /** Every message id the stream has synced — INCLUDING soft-deleted tombstones,
   *  which are absent from `messages`. Lets a card tell "deleted" from "unsynced". */
  seen: Set<string>
  /** Pending optimistic replies the viewer just sent, grouped by their target
   *  conversation id, chronological. These aren't yet in the conversation's
   *  `messageIds`, so a card appends them to whatever it already shows; the
   *  server echo swaps each for the real row (in `messages`, via `messageIds`). */
  pendingByConversation: Map<string, RenderableMessage[]>
  /** False until the first IDB read resolves — distinguishes loading from empty. */
  resolved: boolean
}

const LOADING_RAIL: StreamRail = {
  messages: new Map(),
  seen: new Set(),
  pendingByConversation: new Map(),
  resolved: false,
}

function buildRail(events: CachedEvent[]): StreamRail {
  const messages = new Map<string, RenderableMessage>()
  const seen = new Set<string>()
  const pendingByConversation = new Map<string, RenderableMessage[]>()
  for (const event of events) {
    const payload = (event.payload ?? {}) as MessageCreatedPayloadShape
    if (payload.messageId) seen.add(payload.messageId)
    const message = eventToRenderable(event)
    if (!message) continue
    messages.set(message.id, message)
    // An optimistic reply carries its target conversation so the card can show
    // it before the id lands in `messageIds`. Keep it visible while it's still
    // in flight — `pending` AND `failed`, since the queue cycles a reply through
    // `failed` between retry-backoff attempts; gating on `pending` alone would
    // make a reply blink out for the whole backoff window, then reappear. The
    // server echo deletes the optimistic row, so this set stays bounded.
    if ((event._status === "pending" || event._status === "failed") && payload.conversationId) {
      const list = pendingByConversation.get(payload.conversationId)
      if (list) list.push(message)
      else pendingByConversation.set(payload.conversationId, [message])
    }
  }
  for (const list of pendingByConversation.values()) {
    list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }
  return { messages, seen, pendingByConversation, resolved: true }
}

interface StreamRailEntry {
  rail: StreamRail
  listeners: Set<() => void>
  subscription: Subscription
  refCount: number
}

// INV-9 exception: one shared Dexie subscription per stream, ref-counted across
// every board card in that stream. The board is workspace-wide and renders many
// cards at once — a busy single stream (an AI-persona DM holds hundreds of
// conversations) would otherwise mount one full `message_created` scan per card,
// each re-running on every new message. This module-level registry collapses
// that to one liveQuery per stream; the last card to unmount drops the refCount
// to zero and tears the subscription down (and an account switch remounts the
// whole board subtree, draining it), so no explicit lock/clear wiring is needed.
const railRegistry = new Map<string, StreamRailEntry>()

function subscribeStreamRail(streamId: string, listener: () => void): () => void {
  let entry = railRegistry.get(streamId)
  if (!entry) {
    const created: StreamRailEntry = {
      rail: LOADING_RAIL,
      listeners: new Set(),
      refCount: 0,
      subscription: { unsubscribe() {} } as Subscription,
    }
    // Register BEFORE subscribing so `getSnapshot` (and any synchronous first
    // emission) observes the entry consistently; the callback re-reads the live
    // entry so a late emission after teardown is a no-op.
    railRegistry.set(streamId, created)
    created.subscription = liveQuery(() =>
      db.events.where("[streamId+eventType]").equals([streamId, "message_created"]).toArray()
    ).subscribe((events) => {
      const live = railRegistry.get(streamId)
      if (!live) return
      live.rail = buildRail(events)
      for (const notify of live.listeners) notify()
    })
    entry = created
  }
  entry.listeners.add(listener)
  entry.refCount += 1
  return () => {
    const current = railRegistry.get(streamId)
    if (!current) return
    current.listeners.delete(listener)
    current.refCount -= 1
    if (current.refCount <= 0) {
      current.subscription.unsubscribe()
      railRegistry.delete(streamId)
    }
  }
}

function useStreamRail(streamId: string): StreamRail {
  const subscribe = useCallback((onChange: () => void) => subscribeStreamRail(streamId, onChange), [streamId])
  const getSnapshot = useCallback(() => railRegistry.get(streamId)?.rail ?? LOADING_RAIL, [streamId])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** Tear down every shared stream subscription — for tests, so a module-level
 *  registry can't leak a liveQuery (or a snapshot) across cases. */
export function __clearBoardRailRegistry(): void {
  for (const entry of railRegistry.values()) entry.subscription.unsubscribe()
  railRegistry.clear()
}

export interface BoardCardMessages {
  /** The post's opening message — live from the events rail when synced, else the
   *  cached projection (a thread's parent opening lives in another stream). */
  openingMessage: RenderableMessage | null
  /** Replies present locally, chronological. From the events rail when the card's
   *  stream is synced; otherwise the cached server preview. */
  replies: RenderableMessage[]
  /** Total replies the card claims exist (drives the "N more" gap). Equals the
   *  rail's displayable count once the whole conversation is local (so a deleted
   *  reply can't inflate the gap); otherwise the server count, since older replies
   *  aren't in IDB yet. */
  totalReplies: number
  /** The viewer's own just-sent replies awaiting their server echo, chronological.
   *  Not yet in `messageIds` (so absent from `replies`); the card appends them in
   *  place. Empties as each echo swaps the optimistic row for the real one. */
  pendingReplies: RenderableMessage[]
  /** Where the bodies came from: the live `db.events` rail, or the cached server
   *  projection (a stream not yet synced into IDB — a cold/offline first open). */
  source: "events" | "projection"
}

const NO_PENDING: RenderableMessage[] = []

/**
 * A board card's messages, read OFFLINE-FIRST from the same `db.events` store the
 * timeline rides — never blocking on the network. Live edits, reactions, and sends
 * fill in place because the events rail patches those rows; opening the board on a
 * spotty connection still renders instantly from whatever is in IDB.
 *
 * When the card's stream hasn't synced into IDB yet (a never-opened public channel
 * on a cold device), it falls back to the cached server projection on the
 * conversation row so the card always shows something immediately. The board
 * declares its on-screen card streams to the SyncEngine (useBoardStreamSubscriptions),
 * which catches them up + joins their rooms, so the fallback resolves to the live
 * rail once that sync lands — the projection just covers the cold-open window.
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

  const rail = useStreamRail(streamId)
  const conversationId = post.conversation.id

  return useMemo(() => {
    const pendingReplies = rail.pendingByConversation.get(conversationId) ?? NO_PENDING

    // The server's count excludes `messageIds[0]` for a flat conversation even
    // when that opening was deleted, so trust it when the flat relationship is
    // unknown (deleted opening → `openingId` null).
    const serverTotal = openingId !== null && openingId === messageIds[0] ? messageIds.length - 1 : post.totalReplies

    // The rail "knows" this conversation once it has synced any of its message ids
    // — including soft-deleted ones (in `seen`, absent from `messages`). Gate on
    // raw presence so a wholly-deleted conversation shows its tombstones instead of
    // resurrecting stale bodies, while a conversation whose ids aren't in the synced
    // window keeps the cached preview.
    const openingSeen = openingId !== null && rail.seen.has(openingId)
    const conversationSeen = rail.resolved && (openingSeen || replyIds.some((id) => rail.seen.has(id)))

    let openingMessage = (post.openingMessage as RenderableMessage | null) ?? null
    if (openingId !== null && rail.seen.has(openingId)) openingMessage = rail.messages.get(openingId) ?? null

    if (!conversationSeen) {
      return {
        openingMessage,
        replies: post.recentMessages as RenderableMessage[],
        totalReplies: serverTotal,
        pendingReplies,
        source: "projection",
      }
    }

    const liveReplies: RenderableMessage[] = []
    for (const id of replyIds) {
      const message = rail.messages.get(id)
      if (message) liveReplies.push(message)
    }
    liveReplies.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

    // When the rail holds every one of this conversation's replies, its displayable
    // (non-deleted) count IS the total — a tombstone is "seen" but not shown, so it
    // must not inflate the "N more" gap. Otherwise older replies aren't local yet,
    // so trust the server count and let expand backfill the rest.
    const fullySynced = replyIds.every((id) => rail.seen.has(id))
    const totalReplies = fullySynced ? liveReplies.length : serverTotal

    return { openingMessage, replies: liveReplies, totalReplies, pendingReplies, source: "events" }
  }, [rail, replyIds, openingId, messageIds, post, conversationId])
}
