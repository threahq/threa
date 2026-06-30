import { useCallback, useMemo, useRef, useSyncExternalStore } from "react"
import { liveQuery, type Subscription } from "dexie"
import { db, type CachedEvent } from "@/db"
import { createDraftPanelId } from "@/contexts/panel-context"
import type { RenderableMessage } from "@/components/message/message-item"
import { StreamTypes, type AuthorType } from "@threa/types"
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
    streamId: event.streamId,
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
  /** Renderable rows that carry a `conversationId`, grouped by it, chronological.
   *  A board reply tags its optimistic event with the conversation it attaches to,
   *  and the swap carries that tag onto the real event (stream-sync), so this holds
   *  the reply continuously from optimistic insert through the server echo. The
   *  card unions this with the conversation's server `messageIds`: the tag covers
   *  the reply BEFORE the id lands in `messageIds` (no blink-out at the echo
   *  hand-off); once it's in `messageIds` the card dedups it. Only board replies
   *  carry the tag, so this stays proportional to the stream's reply count. */
  taggedByConversation: Map<string, RenderableMessage[]>
  /** False until the first IDB read resolves — distinguishes loading from empty. */
  resolved: boolean
}

const LOADING_RAIL: StreamRail = {
  messages: new Map(),
  seen: new Set(),
  taggedByConversation: new Map(),
  resolved: false,
}

function buildRail(events: CachedEvent[]): StreamRail {
  const messages = new Map<string, RenderableMessage>()
  const seen = new Set<string>()
  const taggedByConversation = new Map<string, RenderableMessage[]>()
  for (const event of events) {
    const payload = (event.payload ?? {}) as MessageCreatedPayloadShape
    if (payload.messageId) seen.add(payload.messageId)
    const message = eventToRenderable(event)
    if (!message) continue
    messages.set(message.id, message)
    // Group every conversation-tagged row (optimistic OR the swapped real one,
    // any `_status`) so the card can show the reply continuously across the echo
    // hand-off — gating on `_status` would drop the real row the instant the
    // swap clears `pending`, blinking the reply out until `messageIds` catches up.
    if (payload.conversationId) {
      const list = taggedByConversation.get(payload.conversationId)
      if (list) list.push(message)
      else taggedByConversation.set(payload.conversationId, [message])
    }
  }
  for (const list of taggedByConversation.values()) {
    list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }
  return { messages, seen, taggedByConversation, resolved: true }
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

/** Union several stream rails into one. A conversation can span its root + the
 *  root's threads (one root — board-view-design.md), so the card reads every
 *  member's stream and merges them by id. A single rail passes through unchanged
 *  (referentially stable, so a one-stream card never re-merges). */
function mergeRails(rails: StreamRail[]): StreamRail {
  if (rails.length === 1) return rails[0]
  const messages = new Map<string, RenderableMessage>()
  const seen = new Set<string>()
  const taggedByConversation = new Map<string, RenderableMessage[]>()
  // Resolved only once every constituent rail has read — until then the card
  // keeps the cached projection rather than treating an unsynced thread as empty.
  let resolved = true
  for (const rail of rails) {
    if (!rail.resolved) resolved = false
    for (const [id, message] of rail.messages) messages.set(id, message)
    for (const id of rail.seen) seen.add(id)
    for (const [conversationId, list] of rail.taggedByConversation) {
      const existing = taggedByConversation.get(conversationId)
      if (existing) existing.push(...list)
      else taggedByConversation.set(conversationId, [...list])
    }
  }
  for (const list of taggedByConversation.values()) {
    list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }
  return { messages, seen, taggedByConversation, resolved }
}

/**
 * Subscribe to the rails of several streams and return their union as one rail.
 * `streamIds` must be a stable, deduped, sorted array (the caller derives it from
 * the post's stream set) so subscribe/getSnapshot identities only change when the
 * set changes. The merged snapshot is cached and recomputed only when one of the
 * underlying rail references changes — `useSyncExternalStore` requires a stable
 * snapshot, so re-merging on every read would loop.
 */
function useMergedStreamRail(streamIds: string[]): StreamRail {
  const key = streamIds.join(",")
  const cacheRef = useRef<{ inputs: StreamRail[]; merged: StreamRail } | null>(null)

  const subscribe = useCallback(
    (onChange: () => void) => {
      const unsubscribes = streamIds.map((id) => subscribeStreamRail(id, onChange))
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe()
      }
    },
    // `key` captures the set; the closure over `streamIds` is consistent with it.
    [key]
  )

  const getSnapshot = useCallback(() => {
    const inputs = streamIds.map((id) => railRegistry.get(id)?.rail ?? LOADING_RAIL)
    const cached = cacheRef.current
    if (cached && cached.inputs.length === inputs.length && cached.inputs.every((rail, i) => rail === inputs[i])) {
      return cached.merged
    }
    const merged = mergeRails(inputs)
    cacheRef.current = { inputs, merged }
    return merged
  }, [key])

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
  /** Replies known from the rail but not yet in the conversation's server
   *  `messageIds` — the optimistic row, and the swapped real row in the window
   *  before `conversation:updated` lands — chronological. The card appends these
   *  in place so a just-sent reply shows immediately and stays put across the
   *  echo hand-off; each empties once its id appears in `messageIds`. */
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
export function useBoardCardMessages(post: BoardViewPost, hostStreamType?: string): BoardCardMessages {
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

  // The streams this conversation's members span — its anchor, plus every stream
  // the server projection's opening/recent messages live in (a conversation spans
  // its root + the root's threads, one root — board-view-design.md). For a lone
  // channel/DM post mid-convert-to-thread, also watch the optimistic draft-thread
  // panel: the reply is written there (tagged with this conversation) before the
  // thread is promoted, so the card surfaces it in place; once promoted, the real
  // thread joins `streamIds` via `conversation:message_assigned`.
  const streamIdsKey = (post.streamIds ?? []).join(",")
  const threadable = hostStreamType === StreamTypes.CHANNEL || hostStreamType === StreamTypes.DM
  const streamIds = useMemo(() => {
    const set = new Set<string>([streamId])
    for (const id of post.streamIds ?? []) set.add(id)
    if (post.openingMessage?.streamId) set.add(post.openingMessage.streamId)
    for (const message of post.recentMessages) if (message.streamId) set.add(message.streamId)
    if (threadable && messageIds.length <= 1 && openingId) set.add(createDraftPanelId(streamId, openingId))
    return [...set].sort()
  }, [streamId, streamIdsKey, post.openingMessage, post.recentMessages, threadable, messageIds.length, openingId])

  const rail = useMergedStreamRail(streamIds)
  const conversationId = post.conversation.id

  return useMemo(() => {
    // Replies for this conversation the card knows from the rail but the server
    // `messageIds` doesn't list yet — the optimistic row, and the swapped real
    // row in the window before `conversation:updated` lands. Exclude ids already
    // in `replyIds` so a confirmed reply renders once (via `replies`), not twice.
    const replyIdSet = new Set(replyIds)
    const tagged = rail.taggedByConversation.get(conversationId)
    const unconfirmed = tagged ? tagged.filter((m) => !replyIdSet.has(m.id)) : NO_PENDING
    const pendingReplies = unconfirmed.length > 0 ? unconfirmed : NO_PENDING

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
