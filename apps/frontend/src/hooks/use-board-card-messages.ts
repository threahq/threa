import { useCallback, useMemo, useSyncExternalStore } from "react"
import { liveQuery, type Subscription } from "dexie"
import { db, type CachedEvent } from "@/db"
import type { RenderableMessage } from "@/components/message/message-item"
import { ConversationIntents, type AuthorType } from "@threa/types"
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

function useStreamRail(streamId: string): StreamRail {
  const subscribe = useCallback((onChange: () => void) => subscribeStreamRail(streamId, onChange), [streamId])
  const getSnapshot = useCallback(() => railRegistry.get(streamId)?.rail ?? LOADING_RAIL, [streamId])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/**
 * Convert-to-thread board replies in flight, keyed by the SOURCE conversation
 * they thread off — shared across every card in a workspace by one liveQuery
 * (the same INV-9 carve-out the rail registry takes).
 *
 * A lone channel/DM post's board reply is queued as a thread-draft reply
 * (`threadFromMessage`), so its optimistic event lives on the thread-draft
 * stream, never on the source card's own rail — the card can't surface the
 * in-flight reply from `db.events` the way a flat reply does. The pending send
 * row links the reply back to this card (it carries the `sourceConversationId`
 * directive), so reading it lets the source card render the reply in place.
 *
 * The continuity is the load-bearing part. The pending row is deleted on send
 * SUCCESS (the HTTP response), but the thread card that replaces this one only
 * arrives later on the `conversation:*` echo the async outbox dispatches — so
 * keying the reply on the pending row alone blinks it out for that gap. Instead
 * the reply is held until its OPTIMISTIC EVENT is gone: `handleMessageCreated`
 * deletes that event in the same step it writes the real reply onto the thread
 * stream (which is what the new thread card renders), so the source card lets go
 * of the reply exactly as the thread card picks it up. The `links` carried on the
 * registry entry bridge the window after the pending row is deleted but before
 * the event is swapped — re-checking the event by `clientId` clears each as its
 * echo lands. Bodies come from the optimistic event (full attachments).
 */
interface PendingConversionLink {
  sourceConversationId: string
  clientId: string
}

interface ConversionProjection {
  conversions: Map<string, RenderableMessage[]>
  links: PendingConversionLink[]
}

/** Project the surviving optimistic events (those not yet swapped by their echo)
 *  into per-source-conversation reply lists, dropping any whose event is gone. */
function projectConversions(
  linkByClient: Map<string, string>,
  clientIds: string[],
  events: (CachedEvent | undefined)[]
): ConversionProjection {
  const conversions = new Map<string, RenderableMessage[]>()
  const links: PendingConversionLink[] = []
  clientIds.forEach((clientId, i) => {
    const event = events[i]
    const message = event ? eventToRenderable(event) : null
    if (!message) return
    const sourceConversationId = linkByClient.get(clientId)!
    links.push({ sourceConversationId, clientId })
    const list = conversions.get(sourceConversationId)
    if (list) list.push(message)
    else conversions.set(sourceConversationId, [message])
  })
  if (links.length === 0) return EMPTY_PROJECTION
  for (const list of conversions.values()) {
    list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }
  return { conversions, links }
}

interface PendingConversionsEntry {
  conversions: Map<string, RenderableMessage[]>
  /** Conversions still on screen, so a run after the pending row is deleted still
   *  knows which optimistic events to re-check for the echo-swap (the bridge). */
  links: PendingConversionLink[]
  listeners: Set<() => void>
  subscription: Subscription
  refCount: number
}

const EMPTY_CONVERSIONS: Map<string, RenderableMessage[]> = new Map()
const EMPTY_LINKS: PendingConversionLink[] = []
const EMPTY_PROJECTION: ConversionProjection = { conversions: EMPTY_CONVERSIONS, links: EMPTY_LINKS }
const pendingConversionsRegistry = new Map<string, PendingConversionsEntry>()

function subscribePendingConversions(workspaceId: string, listener: () => void): () => void {
  let entry = pendingConversionsRegistry.get(workspaceId)
  if (!entry) {
    const created: PendingConversionsEntry = {
      conversions: EMPTY_CONVERSIONS,
      links: EMPTY_LINKS,
      listeners: new Set(),
      refCount: 0,
      subscription: { unsubscribe() {} } as Subscription,
    }
    pendingConversionsRegistry.set(workspaceId, created)
    created.subscription = liveQuery(async () => {
      // pendingMessages is the in-flight outbox (tiny), so a full scan + JS
      // filter is cheaper than indexing a new column; any outbox write re-runs
      // this, which is fine at that table's size.
      const pendings = (await db.pendingMessages.toArray()).filter(
        (p) => p.workspaceId === workspaceId && p.conversation?.intent === ConversationIntents.THREAD_FROM_MESSAGE
      )
      // Union the still-pending sends with the ones already on screen whose row
      // was deleted on send success (carried `links`) — their optimistic event
      // outlives the row, so they stay visible until the echo swaps it. Pending
      // rows win on key (a re-send reuses the same clientId).
      const carried = pendingConversionsRegistry.get(workspaceId)?.links ?? EMPTY_LINKS
      const linkByClient = new Map<string, string>()
      for (const link of carried) linkByClient.set(link.clientId, link.sourceConversationId)
      for (const p of pendings) {
        if (p.conversation?.intent === ConversationIntents.THREAD_FROM_MESSAGE) {
          linkByClient.set(p.clientId, p.conversation.sourceConversationId)
        }
      }
      if (linkByClient.size === 0) return EMPTY_PROJECTION
      const clientIds = [...linkByClient.keys()]
      // bulkGet observes only these events' own keys, so the swap that deletes one
      // (the echo) re-runs this, but the unrelated message-write firehose doesn't.
      const events = await db.events.bulkGet(clientIds)
      return projectConversions(linkByClient, clientIds, events)
    }).subscribe((projection) => {
      const live = pendingConversionsRegistry.get(workspaceId)
      if (!live) return
      live.conversions = projection.conversions
      live.links = projection.links
      for (const notify of live.listeners) notify()
    })
    entry = created
  }
  entry.listeners.add(listener)
  entry.refCount += 1
  return () => {
    const current = pendingConversionsRegistry.get(workspaceId)
    if (!current) return
    current.listeners.delete(listener)
    current.refCount -= 1
    if (current.refCount <= 0) {
      current.subscription.unsubscribe()
      pendingConversionsRegistry.delete(workspaceId)
    }
  }
}

/** Convert-to-thread replies in flight for the workspace, keyed by the source
 *  conversation each retires. See {@link projectConversions}. */
function usePendingThreadConversions(workspaceId: string): Map<string, RenderableMessage[]> {
  const subscribe = useCallback(
    (onChange: () => void) => subscribePendingConversions(workspaceId, onChange),
    [workspaceId]
  )
  const getSnapshot = useCallback(
    () => pendingConversionsRegistry.get(workspaceId)?.conversions ?? EMPTY_CONVERSIONS,
    [workspaceId]
  )
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** Tear down every shared board subscription — for tests, so a module-level
 *  registry can't leak a liveQuery (or a snapshot) across cases. */
export function __clearBoardRailRegistry(): void {
  for (const entry of railRegistry.values()) entry.subscription.unsubscribe()
  railRegistry.clear()
  for (const entry of pendingConversionsRegistry.values()) entry.subscription.unsubscribe()
  pendingConversionsRegistry.clear()
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
  const pendingConversions = usePendingThreadConversions(post.workspaceId)
  const conversationId = post.conversation.id

  return useMemo(() => {
    // Replies for this conversation the card knows from the rail but the server
    // `messageIds` doesn't list yet — the optimistic row, and the swapped real
    // row in the window before `conversation:updated` lands. Exclude ids already
    // in `replyIds` so a confirmed reply renders once (via `replies`), not twice.
    const replyIdSet = new Set(replyIds)
    const tagged = rail.taggedByConversation.get(conversationId)
    const taggedUnconfirmed = tagged ? tagged.filter((m) => !replyIdSet.has(m.id)) : []
    // A convert-to-thread reply attaches to THIS source conversation but its
    // optimistic event lives on the thread-draft stream, not this card's rail —
    // fold the pending send in (deduped against tagged + confirmed ids) so the
    // lone source card shows the reply in place until the thread card takes over
    // on echo. See `usePendingThreadConversions`.
    const conversionReplies = pendingConversions.get(conversationId) ?? NO_PENDING
    const taggedIds = new Set(taggedUnconfirmed.map((m) => m.id))
    const conversionUnconfirmed = conversionReplies.filter((m) => !replyIdSet.has(m.id) && !taggedIds.has(m.id))
    const merged = [...taggedUnconfirmed, ...conversionUnconfirmed]
    const pendingReplies = merged.length > 0 ? merged : NO_PENDING

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
  }, [rail, pendingConversions, replyIds, openingId, messageIds, post, conversationId])
}
