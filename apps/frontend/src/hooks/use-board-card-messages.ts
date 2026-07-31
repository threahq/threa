import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import { liveQuery, type Subscription } from "dexie"
import { db, type CachedEvent } from "@/db"
import { createDraftPanelId } from "@/contexts/panel-context"
import { RECENT_PREVIEW_CAP } from "@/stores/board-store"
import { useConversationBackfillMessages } from "@/stores/conversation-messages-store"
import type { RenderableMessage } from "@/components/message/message-item"
import { StreamTypes, BOARD_EVENT_ROW_TYPES, type AuthorType, type EventType } from "@threa/types"
import type { BoardViewPost } from "./use-stable-board-view"

/**
 * Event types the board rail reads alongside `message_created`: the non-message
 * rows the board draws (agent sessions, memo captures, follow-ups, delegations —
 * derived from the shared STREAM_ROW_SPEC) plus the two patches that carry no row
 * of their own: `agent:follow_up_cancelled` flips a scheduled card to "Cancelled",
 * `delegation:status_changed` advances a delegation card's status. Registering a
 * new conversation-scoped row kind in the spec adds it here automatically; a
 * PATCH-classed type never derives, so it is listed by hand. Adding a row type
 * whose live updates arrive as a patch means adding that patch HERE too —
 * `board-event-rows.test.ts` ("BOARD_RAIL_EVENT_TYPES covers every patch
 * belonging to a board row type") holds this list to it.
 */
export const BOARD_RAIL_EVENT_TYPES: EventType[] = [
  ...BOARD_EVENT_ROW_TYPES,
  "agent:follow_up_cancelled",
  "delegation:status_changed",
  "message_created",
]

interface MessageCreatedPayloadShape {
  messageId?: string
  contentMarkdown?: string
  reactions?: Record<string, string[]>
  attachments?: RenderableMessage["attachments"]
  linkPreviews?: RenderableMessage["linkPreviews"]
  // Patched onto the row by the live edit handler (stream-sync) and by bootstrap
  // enrichment for an already-edited message, so the rail carries it too.
  editedAt?: string | null
  deletedAt?: string | null
  /** Set only on an optimistic board reply, naming the conversation it attaches
   *  to so a card can surface the pending row before the server echo lands. */
  conversationId?: string
  /** On a server echo: the optimistic (client) id this message confirms. The
   *  swap deletes that temp row, but a card merges several independent rails —
   *  one can still hold a stale snapshot with the temp row while another already
   *  shows the echo, doubling the reply for a frame. This is the precise link
   *  that lets the card suppress the superseded copy. */
  clientMessageId?: string
}

/** Project a `message_created` event row into the shared render shape the timeline
 *  and the board both use. Returns null for a non-message or soft-deleted row. */
function eventToRenderable(event: CachedEvent): RenderableMessage | null {
  const p = (event.payload ?? {}) as MessageCreatedPayloadShape
  if (!p.messageId || p.deletedAt) return null
  return {
    id: p.messageId,
    streamId: event.streamId,
    sequence: event.sequence,
    authorId: event.actorId ?? "",
    authorType: (event.actorType ?? "user") as AuthorType,
    contentMarkdown: p.contentMarkdown ?? "",
    reactions: p.reactions ?? {},
    createdAt: event.createdAt,
    editedAt: p.editedAt ?? null,
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
  /** Soft-deleted `message_created` rows as content-free tombstone rows, by id.
   *  Deliberately SEPARATE from `messages`: the collapsed card's reply window and
   *  its "N more" arithmetic count displayable replies only, so a tombstone must
   *  not take a slot there. Only the always-expanded conversation panel reads
   *  this, and renders each as "This message was deleted". */
  deletedMessages: Map<string, RenderableMessage>
  /** Renderable rows that carry a `conversationId`, grouped by it, chronological.
   *  A board reply tags its optimistic event with the conversation it attaches to,
   *  and the swap carries that tag onto the real event (stream-sync), so this holds
   *  the reply continuously from optimistic insert through the server echo. The
   *  card unions this with the conversation's server `messageIds`: the tag covers
   *  the reply BEFORE the id lands in `messageIds` (no blink-out at the echo
   *  hand-off); once it's in `messageIds` the card dedups it. Only board replies
   *  carry the tag, so this stays proportional to the stream's reply count. */
  taggedByConversation: Map<string, RenderableMessage[]>
  /** The optimistic (client) ids confirmed by a real row on this stream —
   *  `payload.clientMessageId` of every synced message. A temp row with its id
   *  here is superseded: it may linger in another rail's stale snapshot (or in
   *  IDB until the swap's delete lands), and rendering it beside its confirmed
   *  twin doubles the reply for a frame. */
  supersededClientIds: Set<string>
  /** Spec-eligible non-message rows on this stream (agent sessions, memo captures,
   *  follow-up scheduled/cancelled), in read order — resolved to conversation rows
   *  by `resolveBoardEventRows`. Render-only: none is a member or bumps activity. */
  events: CachedEvent[]
  /** False until the first IDB read resolves — distinguishes loading from empty. */
  resolved: boolean
}

const LOADING_RAIL: StreamRail = {
  messages: new Map(),
  seen: new Set(),
  deletedMessages: new Map(),
  taggedByConversation: new Map(),
  supersededClientIds: new Set(),
  events: [],
  resolved: false,
}

function buildRail(events: CachedEvent[], overlay?: Map<string, CachedEvent>): StreamRail {
  const messages = new Map<string, RenderableMessage>()
  const seen = new Set<string>()
  const deletedMessages = new Map<string, RenderableMessage>()
  const taggedByConversation = new Map<string, RenderableMessage[]>()
  const supersededClientIds = new Set<string>()
  const eventRows: CachedEvent[] = []
  // A just-sent row the IDB read can't see yet rides in the overlay, merged under
  // the emission: once the persisted copy lands it wins by id, so a reply is never
  // built twice. Order is irrelevant — messages key by id and the tagged lists sort
  // by `createdAt` below.
  const source = overlay ? [...new Map([...overlay, ...events.map((e) => [e.id, e] as const)]).values()] : events
  for (const event of source) {
    // The rail reads message_created + the board's non-message row types; anything
    // that isn't a message is a spec event row (a trace/memo/follow-up).
    if (event.eventType !== "message_created") {
      eventRows.push(event)
      continue
    }
    const payload = (event.payload ?? {}) as MessageCreatedPayloadShape
    if (payload.messageId) seen.add(payload.messageId)
    // Only a real (synced) row supersedes: the optimistic row itself carries no
    // clientMessageId, so a pending row can never suppress anything.
    if (payload.clientMessageId && !event._status) supersededClientIds.add(payload.clientMessageId)
    const message = eventToRenderable(event)
    if (!message) {
      if (payload.messageId && payload.deletedAt) {
        deletedMessages.set(payload.messageId, {
          id: payload.messageId,
          streamId: event.streamId,
          sequence: event.sequence,
          authorId: event.actorId ?? "",
          authorType: (event.actorType ?? "user") as AuthorType,
          contentMarkdown: "",
          reactions: {},
          createdAt: event.createdAt,
          deletedAt: payload.deletedAt,
        })
      }
      continue
    }
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
  return {
    messages,
    seen,
    deletedMessages,
    taggedByConversation,
    supersededClientIds,
    events: eventRows,
    resolved: true,
  }
}

interface StreamRailEntry {
  rail: StreamRail
  /** The last liveQuery emission, kept so an overlay publish can rebuild the rail
   *  without re-reading IDB. */
  events: CachedEvent[]
  listeners: Set<() => void>
  subscription: Subscription
  refCount: number
  /** Pending grace-period teardown, armed when the last subscriber leaves. */
  teardown: ReturnType<typeof setTimeout> | null
}

/**
 * How long a rail outlives its last subscriber. A card's stream-id set changes
 * in place as its conversation grows (a thread is discovered, the draft panel
 * drops once messageIds widen, `message_assigned` moves the thread into the
 * gating set), and `useSyncExternalStore` re-subscribes by tearing the old
 * subscription down before attaching the new one — an immediate teardown would
 * destroy every rail at each of those steps and recreate them unresolved,
 * flashing the card back to its stale projection while the fresh liveQueries
 * run their first read. The grace keeps the rail (and its resolved data) alive
 * across the swap; a genuinely abandoned rail still drains when the timer fires.
 */
const RAIL_TEARDOWN_GRACE_MS = 5000

// INV-9 exception: one shared Dexie subscription per stream, ref-counted across
// every board card in that stream. The board is workspace-wide and renders many
// cards at once — a busy single stream (an AI-persona DM holds hundreds of
// conversations) would otherwise mount one full `message_created` scan per card,
// each re-running on every new message. This module-level registry collapses
// that to one liveQuery per stream; the last card to unmount drops the refCount
// to zero and tears the subscription down (and an account switch remounts the
// whole board subtree, draining it), so no explicit lock/clear wiring is needed.
const railRegistry = new Map<string, StreamRailEntry>()

/**
 * Just-sent rows the rail shows before IDB has emitted them, by stream then id.
 *
 * The sender's own reply is written to `db.events` and reaches the card through
 * Dexie's `liveQuery` — a write commit plus a full re-read of the stream, ~140ms
 * on a desktop dev build and visibly worse on a phone, all of it AFTER the
 * composer has already cleared, which is what made a board reply feel unsent.
 * `publishOptimisticRailEvent` puts the row on the rail in the sending tick
 * instead; the persisted copy takes over silently when the emission carrying it
 * arrives (`buildRail` prefers it by id).
 *
 * An entry leaves when the stream's emission holds the row, when the echo swap's
 * real row supersedes it (`clientMessageId`), when the send is deleted, or with
 * the rail itself at teardown — the last one matters because the emission that
 * would prune it dies with the subscription. A row that outlives its confirmation
 * inside a live rail is still harmless: the same `supersededClientIds` rule that
 * covers a stale merged-rail snapshot filters it (the convert-to-thread swap
 * moves the real row to another stream, so its rail never sees the temp id).
 */
const optimisticOverlay = new Map<string, Map<string, CachedEvent>>()

/**
 * Show a just-queued optimistic event on its stream's board rail now, without
 * waiting for the IDB write to round-trip through `liveQuery`. Called by the
 * send path (`useQueueDraftMessage`) immediately before the write it mirrors.
 */
export function publishOptimisticRailEvent(event: CachedEvent): void {
  const entry = railRegistry.get(event.streamId)
  // No rail means no board card is reading this stream — nothing to make eager,
  // and no liveQuery would ever emit to prune the entry (the send paths that
  // create a scratchpad or a thread out of view come through here too).
  if (!entry) return
  const overlay = optimisticOverlay.get(event.streamId) ?? new Map<string, CachedEvent>()
  overlay.set(event.id, event)
  optimisticOverlay.set(event.streamId, overlay)
  // An unresolved rail is still doing its first read: rebuilding it here would
  // publish `resolved: true` over an empty event set and flip cards off their
  // projection with nothing to show. Its first emission picks the overlay up.
  if (!entry.rail.resolved) return
  entry.rail = buildRail(entry.events, overlay)
  for (const notify of entry.listeners) notify()
}

/** Drop a published row — its send was deleted, or its write failed, so no
 *  emission will ever confirm it. */
export function revokeOptimisticRailEvent(id: string): void {
  for (const [streamId, overlay] of optimisticOverlay) {
    if (!overlay.delete(id)) continue
    if (overlay.size === 0) optimisticOverlay.delete(streamId)
    const entry = railRegistry.get(streamId)
    if (!entry || !entry.rail.resolved) continue
    entry.rail = buildRail(entry.events, optimisticOverlay.get(streamId))
    for (const notify of entry.listeners) notify()
  }
}

/** Forget overlay rows the emission now carries (or whose echo supersedes them),
 *  so the persisted copy is the only one the rail builds from. */
function pruneOverlay(streamId: string, events: CachedEvent[]): Map<string, CachedEvent> | undefined {
  const overlay = optimisticOverlay.get(streamId)
  if (!overlay) return undefined
  for (const event of events) {
    overlay.delete(event.id)
    const clientMessageId = (event.payload as MessageCreatedPayloadShape | undefined)?.clientMessageId
    if (clientMessageId) overlay.delete(clientMessageId)
  }
  if (overlay.size > 0) return overlay
  optimisticOverlay.delete(streamId)
  return undefined
}

function subscribeStreamRail(streamId: string, listener: () => void): () => void {
  let entry = railRegistry.get(streamId)
  if (!entry) {
    const created: StreamRailEntry = {
      rail: LOADING_RAIL,
      events: [],
      listeners: new Set(),
      refCount: 0,
      subscription: { unsubscribe() {} } as Subscription,
      teardown: null,
    }
    // Register BEFORE subscribing so `getSnapshot` (and any synchronous first
    // emission) observes the entry consistently; the callback re-reads the live
    // entry so a late emission after teardown is a no-op.
    railRegistry.set(streamId, created)
    created.subscription = liveQuery(() =>
      db.events
        .where("[streamId+eventType]")
        .anyOf(BOARD_RAIL_EVENT_TYPES.map((eventType) => [streamId, eventType]))
        .toArray()
    ).subscribe((events) => {
      const live = railRegistry.get(streamId)
      if (!live) return
      live.events = events
      live.rail = buildRail(events, pruneOverlay(streamId, events))
      for (const notify of live.listeners) notify()
    })
    entry = created
  }
  if (entry.teardown) {
    clearTimeout(entry.teardown)
    entry.teardown = null
  }
  entry.listeners.add(listener)
  entry.refCount += 1
  return () => {
    const current = railRegistry.get(streamId)
    if (!current) return
    current.listeners.delete(listener)
    current.refCount -= 1
    if (current.refCount <= 0 && !current.teardown) {
      current.teardown = setTimeout(() => {
        const live = railRegistry.get(streamId)
        if (!live || live.refCount > 0) return
        live.subscription.unsubscribe()
        railRegistry.delete(streamId)
        // The emission that would have pruned this stream's published rows dies
        // with the subscription, so drop them here: nobody is rendering them, and
        // on a later re-subscribe the persisted copy is what should appear — a
        // surviving entry would resurrect a row IDB may no longer have.
        optimisticOverlay.delete(streamId)
      }, RAIL_TEARDOWN_GRACE_MS)
    }
  }
}

/** A card's merged view over its rails. `resolved` gates the projection fallback
 *  (gating rails only); `allResolved` is false while ANY rail — including a
 *  discovered thread or the draft panel — is mid-load, the window where a row the
 *  card was showing can transiently sit in a rail that hasn't read yet. */
interface MergedRail extends StreamRail {
  allResolved: boolean
}

/** Union several stream rails into one. A conversation can span its root + the
 *  root's threads (one root — board-view-design.md), so the card reads every
 *  member's stream and merges them by id. `gatingCount` is how many of the leading
 *  rails are server-known member streams that gate `resolved`; rails past it are
 *  opportunistically-discovered threads (and the optimistic draft panel) that
 *  CONTRIBUTE content but must not drag the card back to its projection while they
 *  load — otherwise discovering a new thread re-flashes an already-live card. */
function mergeRails(rails: StreamRail[], gatingCount: number): MergedRail {
  if (rails.length === 1) return { ...rails[0], allResolved: rails[0].resolved }
  const messages = new Map<string, RenderableMessage>()
  const seen = new Set<string>()
  const deletedMessages = new Map<string, RenderableMessage>()
  const taggedByConversation = new Map<string, RenderableMessage[]>()
  const supersededClientIds = new Set<string>()
  const eventsById = new Map<string, CachedEvent>()
  // Resolved once every GATING rail has read — a still-loading discovered thread
  // doesn't count, so the card keeps its live view instead of dropping to the
  // projection the instant a thread appears.
  let resolved = true
  let allResolved = true
  rails.forEach((rail, i) => {
    if (!rail.resolved) {
      allResolved = false
      if (i < gatingCount) resolved = false
    }
    for (const [id, message] of rail.messages) messages.set(id, message)
    for (const id of rail.seen) seen.add(id)
    for (const [id, message] of rail.deletedMessages) deletedMessages.set(id, message)
    for (const id of rail.supersededClientIds) supersededClientIds.add(id)
    for (const event of rail.events) eventsById.set(event.id, event)
    for (const [conversationId, list] of rail.taggedByConversation) {
      const existing = taggedByConversation.get(conversationId)
      if (existing) existing.push(...list)
      else taggedByConversation.set(conversationId, [...list])
    }
  })
  for (const list of taggedByConversation.values()) {
    list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }
  const events = [...eventsById.values()].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  )
  return {
    messages,
    seen,
    deletedMessages,
    taggedByConversation,
    supersededClientIds,
    events,
    resolved,
    allResolved,
  }
}

/**
 * Subscribe to the rails of several streams and return their union as one rail.
 * `gatingStreamIds` are the server-known member streams (their loading gates the
 * card's resolved state); `extraStreamIds` are discovered threads + the optimistic
 * draft panel (content only). Both must be stable, deduped, sorted arrays so
 * subscribe/getSnapshot identities only change when the set changes. The merged
 * snapshot is cached and recomputed only when one of the underlying rail
 * references changes — `useSyncExternalStore` requires a stable snapshot, so
 * re-merging on every read would loop.
 */
function useMergedStreamRail(gatingStreamIds: string[], extraStreamIds: string[]): MergedRail {
  const gatingCount = gatingStreamIds.length
  const gatingKey = gatingStreamIds.join(",")
  const extraKey = extraStreamIds.join(",")
  const streamIds = useMemo(() => [...gatingStreamIds, ...extraStreamIds], [gatingKey, extraKey])
  const key = gatingKey + "|" + extraKey
  const cacheRef = useRef<{ inputs: StreamRail[]; merged: MergedRail } | null>(null)

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
    const merged = mergeRails(inputs, gatingCount)
    cacheRef.current = { inputs, merged }
    return merged
  }, [key])

  return useSyncExternalStore(subscribe, getSnapshot)
}

interface ThreadIndexEntry {
  /** parent message id → its thread's stream id, for every thread in the workspace. */
  byParent: Map<string, string>
  listeners: Set<() => void>
  subscription: Subscription
  refCount: number
}

// INV-9 exception: one shared `[workspaceId+type]=thread` liveQuery for the whole
// board, ref-counted across cards. A board card's conversation can move into a
// thread (convert-to-thread, or a cross-stream continuation); the thread's stream
// is created at promotion — BEFORE the reply's message echo swaps the optimistic
// row onto it — so resolving "the thread off message X" from `db.streams` here
// subscribes the card to that rail ahead of the swap, closing the gap where a
// just-sent reply would otherwise blink out between the swap and the slower
// `conversation:message_assigned` widening of the server `streamIds`.
const threadIndexRegistry = new Map<string, ThreadIndexEntry>()
const EMPTY_THREAD_IDS: string[] = []

function subscribeChildThreadIndex(workspaceId: string, listener: () => void): () => void {
  let entry = threadIndexRegistry.get(workspaceId)
  if (!entry) {
    const created: ThreadIndexEntry = {
      byParent: new Map(),
      listeners: new Set(),
      refCount: 0,
      subscription: { unsubscribe() {} } as Subscription,
    }
    threadIndexRegistry.set(workspaceId, created)
    created.subscription = liveQuery(() =>
      db.streams.where("[workspaceId+type]").equals([workspaceId, StreamTypes.THREAD]).toArray()
    ).subscribe((threads) => {
      const live = threadIndexRegistry.get(workspaceId)
      if (!live) return
      const byParent = new Map<string, string>()
      for (const thread of threads) {
        const anchor = thread.parentAnchorId ?? thread.parentMessageId
        if (anchor) byParent.set(anchor, thread.id)
      }
      live.byParent = byParent
      for (const notify of live.listeners) notify()
    })
    entry = created
  }
  entry.listeners.add(listener)
  entry.refCount += 1
  return () => {
    const current = threadIndexRegistry.get(workspaceId)
    if (!current) return
    current.listeners.delete(listener)
    current.refCount -= 1
    if (current.refCount <= 0) {
      current.subscription.unsubscribe()
      threadIndexRegistry.delete(workspaceId)
    }
  }
}

/** The stream ids of the threads hanging off any of `parentMessageIds`, live from
 *  `db.streams`. Used to fold a conversation's thread streams into the card's rail
 *  set the moment the thread exists, independent of `conversation:*` event timing. */
function useChildThreadStreamIds(workspaceId: string, parentMessageIds: string[]): string[] {
  const parentsKey = parentMessageIds.join(",")
  const cacheRef = useRef<{ byParent: Map<string, string> | null; parentsKey: string; result: string[] } | null>(null)

  const subscribe = useCallback(
    (onChange: () => void) => subscribeChildThreadIndex(workspaceId, onChange),
    [workspaceId]
  )

  const getSnapshot = useCallback(() => {
    const byParent = threadIndexRegistry.get(workspaceId)?.byParent ?? null
    const cached = cacheRef.current
    if (cached && cached.byParent === byParent && cached.parentsKey === parentsKey) return cached.result
    const ids: string[] = []
    if (byParent)
      for (const parentId of parentMessageIds) {
        const threadId = byParent.get(parentId)
        if (threadId) ids.push(threadId)
      }
    const result = ids.length > 0 ? ids : EMPTY_THREAD_IDS
    cacheRef.current = { byParent, parentsKey, result }
    return result
  }, [workspaceId, parentsKey])

  return useSyncExternalStore(subscribe, getSnapshot)
}

/**
 * Pre-warm the rails behind `streamIds` and report when every one has completed
 * its first IDB read. The board page holds its first card paint on this (plus the
 * conversation graph) so a card's first frame is its FINAL frame — bodies, branch
 * groups, and event rows all present at once instead of resolving in over the
 * next few hundred milliseconds (the refresh pop-in Kris rejected, 2026-07-05).
 * Subscribing here creates the shared registry entries, so cards mounting after
 * the reveal reuse already-resolved rails.
 */
export function useBoardRailsReady(streamIds: string[]): boolean {
  const key = streamIds.join(",")
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
  const getSnapshot = useCallback(() => streamIds.every((id) => railRegistry.get(id)?.rail.resolved ?? false), [key])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** How many stream rails the registry currently holds — for tests, to prove a
 *  drained rail is actually torn down once its grace elapses (the leak half of
 *  the grace-teardown contract). */
export function __boardRailRegistrySize(): number {
  return railRegistry.size
}

/** Tear down every shared stream subscription — for tests, so a module-level
 *  registry can't leak a liveQuery (or a snapshot) across cases. */
export function __clearBoardRailRegistry(): void {
  for (const entry of railRegistry.values()) {
    if (entry.teardown) clearTimeout(entry.teardown)
    entry.subscription.unsubscribe()
  }
  railRegistry.clear()
  optimisticOverlay.clear()
  for (const entry of threadIndexRegistry.values()) entry.subscription.unsubscribe()
  threadIndexRegistry.clear()
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
  /** Where the bodies came from: the live `db.events` rail, the cached backfill
   *  store (fetched + live-patched, for members the rail's window doesn't hold),
   *  or the board projection snapshot — the last-resort cold-start layer before
   *  any fetch lands. */
  source: "events" | "backfill" | "projection"
  /** Every member id the card can render locally — the rail's synced set (live
   *  rows and tombstones) unioned with the backfill store's. The panel gates its
   *  backfill invalidation on this: a membership change naming only ids already
   *  here needs no refetch. */
  knownMessageIds: ReadonlySet<string>
  /** Whether the live `db.events` rail ALONE covers the conversation's current
   *  membership. Deliberately excludes the backfill store: that store is a render
   *  cache, not a fetch suppressor, so a warm store must not stop the surface from
   *  refetching fresh edits/deletes/reactions for members the rail never carries.
   *  This is the `enabled` input of the board-messages query on both surfaces. */
  railCoversMembership: boolean
  /** Spec-eligible non-message rows across the conversation's streams (agent
   *  sessions, memo captures, follow-ups), unresolved — the card runs
   *  `resolveBoardEventRows` to filter+group them to this conversation. Always the
   *  live rail's rows (empty on a cold projection open, filled once synced). */
  events: CachedEvent[]
  /** The merged rail's renderable message rows by id — the card resolves a nested
   *  branch conversation's own messages through this (its `messageIds` ∪ the rows
   *  tagged with its id). Live off the same `db.events` rail. */
  messagesById: Map<string, RenderableMessage>
  /** Rail rows tagged by the conversation they attach to — a just-sent branch reply
   *  shows in its branch through its echo window before the branch's server
   *  `messageIds` lists it, the same union the card does for its own replies. */
  taggedByConversation: Map<string, RenderableMessage[]>
  /** The merged rail's soft-deleted rows as content-free tombstones, by id. The
   *  conversation's own deleted members already ride `replies` (counting zero toward
   *  `totalReplies`); this exposes the rest of the rail's tombstones for surfaces
   *  that resolve rows outside the conversation (nested branches). */
  deletedById: Map<string, RenderableMessage>
  /** The post's provisional (still-settling) member ids. The hook already stamps
   *  its own rows; surfaces that merge a server backfill run their merged list
   *  through {@link applySettlingAll} with this so a backfilled row is marked too. */
  settlingIds: ReadonlySet<string>
}

/** Extra rails a board card subscribes to beyond its conversation's own streams:
 *  the branch conversations it renders nested, and the draft-thread panels of any
 *  in-flight "new sub-topic" gestures. Both are content-only (non-gating), so a
 *  branch rail that's mid-load never drags the card back to its projection. */
export interface BoardCardExtraRails {
  /** Thread streams of the branch conversations the card renders (direct + nested).
   *  Routed to EXTRA even though the suppression folds them into `post.streamIds`
   *  for the board-page subscription, so they don't gate the parent card. */
  branchStreamIds?: string[]
  /** Draft-panel ids (`createDraftPanelId`) of open/pending inline "new sub-topic"
   *  composers, so their optimistic message renders before the thread echo lands. */
  extraDraftPanelIds?: string[]
}

const NO_PENDING: RenderableMessage[] = []
const NO_SETTLING: ReadonlySet<string> = new Set<string>()

/**
 * Stamp the board post's provisional-placement state onto a row. A row already
 * in the wanted state comes back by IDENTITY (no copy), so a settled card
 * renders exactly what it rendered before the feature existed and a re-render
 * of an already-marked row allocates nothing. A tombstone is never marked:
 * deleted trumps settling.
 *
 * The rail's row objects are shared across every card reading that stream, so
 * marking happens here — per card, at row assembly — never inside `buildRail`.
 */
export function applySettling(message: RenderableMessage, settlingIds: ReadonlySet<string>): RenderableMessage {
  const shouldSettle = !message.deletedAt && settlingIds.has(message.id)
  if (Boolean(message.settling) === shouldSettle) return message
  return { ...message, settling: shouldSettle }
}

/** Map {@link applySettling} over a list, returning the SAME array when nothing
 *  is settling so downstream memos don't churn. */
export function applySettlingAll(messages: RenderableMessage[], settlingIds: ReadonlySet<string>): RenderableMessage[] {
  let changed = false
  const next = messages.map((message) => {
    const marked = applySettling(message, settlingIds)
    if (marked !== message) changed = true
    return marked
  })
  return changed ? next : messages
}

// The memoized per-render derivation below; the rail's message maps are appended
// at the return boundary (they come straight off the merged rail, not the view).
type BoardCardView = Omit<
  BoardCardMessages,
  "messagesById" | "taggedByConversation" | "deletedById" | "settlingIds" | "knownMessageIds" | "railCoversMembership"
> & {
  nextRetained: RenderableMessage[]
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
 * declares its on-screen card streams to the SyncEngine (useBoardStreamSubscriptions),
 * which catches them up + joins their rooms, so the fallback resolves to the live
 * rail once that sync lands — the projection just covers the cold-open window.
 */
export function useBoardCardMessages(
  post: BoardViewPost,
  hostStreamType?: string,
  extraRails?: BoardCardExtraRails
): BoardCardMessages {
  const streamId = post.conversation.streamId
  const messageIds = post.conversation.messageIds
  const openingId = post.openingMessage?.id ?? null
  const branchStreamIds = extraRails?.branchStreamIds ?? EMPTY_THREAD_IDS
  const branchStreamKey = branchStreamIds.join(",")
  const extraDraftPanelIds = extraRails?.extraDraftPanelIds ?? EMPTY_THREAD_IDS
  const extraDraftPanelKey = extraDraftPanelIds.join(",")

  // Flat conversation: the opening is `messageIds[0]`, replies are the rest. A
  // thread's opening is the parent message (not a member), so every messageId is a
  // reply. Mirrors the server board projection (service.ts:listByWorkspace).
  const replyIds = useMemo(
    () => (openingId && openingId === messageIds[0] ? messageIds.slice(1) : messageIds),
    [openingId, messageIds]
  )

  // The streams this conversation's members span — its anchor, the streams the
  // server projection's opening/recent messages live in, and the threads hanging
  // off its messages resolved live from `db.streams` (a conversation spans its
  // root + the root's threads, one root — board-view-design.md). The live thread
  // resolution closes the convert-to-thread gap: the thread stream exists at
  // promotion, ahead of the reply's message echo, so the card is already
  // subscribed to it when the optimistic row swaps onto it — no blink. The
  // optimistic draft-thread panel covers the pre-promotion window (the reply is
  // tagged with this conversation there, before any real thread exists).
  // `messageIdsKey` proxies the messageIds content so the memos below key on a
  // stable string, not the array reference.
  const messageIdsKey = messageIds.join(",")
  const parentMessageIds = useMemo(
    () => [...new Set([...(openingId ? [openingId] : []), ...messageIds])],
    [openingId, messageIdsKey]
  )
  const childThreadIds = useChildThreadStreamIds(post.workspaceId, parentMessageIds)
  const childThreadKey = childThreadIds.join(",")
  const streamIdsKey = (post.streamIds ?? []).join(",")
  const openingStreamId = post.openingMessage?.streamId ?? null
  const recentStreamsKey = post.recentMessages.map((m) => m.streamId ?? "").join(",")
  const threadable = hostStreamType === StreamTypes.CHANNEL || hostStreamType === StreamTypes.DM
  // Server-known member streams gate the card's resolved state; discovered threads
  // + the optimistic draft panel only contribute content (so finding one mid-render
  // never flips the card back to its projection). Keyed on stable primitives, not
  // the post.* objects (which a parent re-render would re-create, churning subs).
  const gatingStreamIds = useMemo(() => {
    // Branch conversation streams the suppression folded into `post.streamIds` (for
    // the board-page subscription) must NOT gate this card — they're a separate
    // conversation the card only renders; route them to EXTRA below instead.
    const branchSet = new Set(branchStreamIds)
    const set = new Set<string>([streamId])
    for (const id of post.streamIds ?? []) if (!branchSet.has(id)) set.add(id)
    if (openingStreamId) set.add(openingStreamId)
    for (const message of post.recentMessages) if (message.streamId) set.add(message.streamId)
    return [...set].sort()
  }, [streamId, streamIdsKey, openingStreamId, recentStreamsKey, branchStreamKey])
  const gatingKey = gatingStreamIds.join(",")
  const extraStreamIds = useMemo(() => {
    const gating = new Set(gatingStreamIds)
    const set = new Set<string>()
    for (const id of childThreadIds) if (!gating.has(id)) set.add(id)
    // The branch conversations the card renders nested, and any open/pending
    // inline "new sub-topic" draft panels — content-only, so a mid-load branch
    // rail never flips the parent card back to its projection.
    for (const id of branchStreamIds) if (!gating.has(id)) set.add(id)
    for (const id of extraDraftPanelIds) if (!gating.has(id)) set.add(id)
    if (threadable && messageIds.length <= 1 && openingId) {
      const panel = createDraftPanelId(streamId, openingId)
      if (!gating.has(panel)) set.add(panel)
    }
    return [...set].sort()
  }, [childThreadKey, gatingKey, threadable, messageIdsKey, openingId, streamId, branchStreamKey, extraDraftPanelKey])

  const rail = useMergedStreamRail(gatingStreamIds, extraStreamIds)
  const conversationId = post.conversation.id

  // The backfill store only matters while the rail's window is missing members —
  // subscribing unconditionally would put a Dexie subscription behind every card
  // on the board (the #1640 cost class). Gate on the rail having READ first: an
  // unresolved rail knows nothing, and enabling on it would churn the
  // subscription on every card mount.
  const railKnowsEveryMember =
    (openingId === null || rail.seen.has(openingId)) && replyIds.every((id) => rail.seen.has(id))
  const backfillRows = useConversationBackfillMessages(conversationId, {
    enabled: rail.resolved && !railKnowsEveryMember,
  })
  const backfillById = useMemo(() => {
    if (backfillRows.length === 0) return null
    const map = new Map<string, RenderableMessage>()
    for (const row of backfillRows) {
      map.set(row.messageId, {
        id: row.id,
        streamId: row.streamId,
        authorId: row.authorId,
        authorType: row.authorType,
        contentMarkdown: row.contentMarkdown,
        reactions: row.reactions,
        attachments: row.attachments,
        linkPreviews: row.linkPreviews,
        createdAt: row.createdAt,
        editedAt: row.editedAt,
        deletedAt: row.deletedAt ?? null,
      })
    }
    return map
  }, [backfillRows])
  // One Set per card, rebuilt only when the post's settling set actually changes
  // (the `conversation:updated` echo carrying a settle) — never a per-row scan.
  const settlingKey = (post.settlingMessageIds ?? []).join(",")
  const settlingIds = useMemo<ReadonlySet<string>>(
    () => (settlingKey ? new Set(settlingKey.split(",")) : NO_SETTLING),
    [settlingKey]
  )
  // The viewer's just-sent reply, kept alive across the convert-to-thread hand-off.
  // When a lone post's first reply lands, its optimistic row is swapped onto a
  // freshly-created thread stream the card is still catching up to, and for a beat
  // it's also absent from `messageIds` — so it belongs to no subscribed rail and
  // would blink out / collapse under "1 more". Holding the last-shown copy bridges
  // that window until the real row renders.
  const retainedPendingRef = useRef<RenderableMessage[]>(NO_PENDING)
  // The last events-sourced view, held so an unresolved-rails beat re-renders
  // exactly what was on screen instead of a shrunken derivation or the stale
  // projection. The merged rail passes through `allResolved: false` whenever a
  // rail is mid-first-read — the card's stream-id set changed (re-subscription),
  // a thread was just discovered, or `message_assigned` named a fresh gating
  // stream — all transient. A genuine cold read (rails resolved, ids unseen)
  // still falls through to the projection.
  const lastLiveRef = useRef<{ conversationId: string; view: BoardCardView } | null>(null)
  // The reply ids the conversation already listed when the current in-flight
  // send began. Only an id that JOINS `messageIds` during the episode can be the
  // pending row's server-side identity (the echo race the phantom-gap discount
  // below covers); an id already listed before the send is unsynced older
  // history and must keep counting toward the "N more" gap. Snapshot on the
  // pending 0→N transition, cleared when the episode drains.
  const pendingEpisodeRef = useRef<{ conversationId: string; baseline: Set<string> } | null>(null)

  const view = useMemo(() => {
    // The retained copy is read here but written only after commit (the effect
    // below) — mutating a ref during render is unsafe under concurrent rendering,
    // where a discarded render could clear the bridge before it paints.
    const retained = retainedPendingRef.current

    // Any rail mid-load — a re-subscription after the card's stream-id set
    // changed, or a just-discovered thread running its first read — is a window
    // where a row this card was showing can be absent from every readable rail.
    // Hold the last live view perfectly still for that beat instead of
    // re-deriving a shrunken one or flashing the projection (INV-61's no-motion
    // rule, inside the card).
    const lastLive = lastLiveRef.current
    if (!rail.allResolved && lastLive?.conversationId === conversationId) return lastLive.view

    // Replies for this conversation the card knows from the rail but the server
    // `messageIds` doesn't list yet — the optimistic row, and the swapped real
    // row in the window before `conversation:updated` lands. Exclude ids already
    // in `replyIds` so a confirmed reply renders once (via `replies`), not twice.
    // Exclude superseded optimistic rows too: the echo swap deletes the temp row,
    // but a merged rail can pair one rail's fresh snapshot (echo present) with
    // another's stale one (temp still there) — without this the reply renders
    // doubled for that frame.
    // The backfill fetch is the server's own member list, so it can name replies
    // a stale `messageIds` snapshot doesn't — the panel used to render its rows
    // wholesale for exactly that reason. Union the two so a fresher fetch still
    // widens the conversation; the rail keeps precedence on every shared id.
    const memberReplyIds =
      backfillById === null
        ? replyIds
        : [...new Set([...replyIds, ...[...backfillById.keys()].filter((id) => id !== openingId)])]
    const replyIdSet = new Set(memberReplyIds)
    const tagged = rail.taggedByConversation.get(conversationId)
    const unconfirmed = tagged
      ? tagged.filter((m) => !replyIdSet.has(m.id) && !rail.supersededClientIds.has(m.id))
      : NO_PENDING
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
    // The backfill store is the middle layer: fetched from the server for
    // exactly the members the rail's window doesn't hold, and patched by the
    // same live handlers, so it beats the projection snapshot (which only a
    // board refetch ever rewrites) everywhere the rail is silent.
    const backfillSeen =
      backfillById !== null &&
      ((openingId !== null && backfillById.has(openingId)) || replyIds.some((id) => backfillById.has(id)))

    let openingMessage = (post.openingMessage as RenderableMessage | null) ?? null
    if (openingId !== null && backfillById?.has(openingId)) openingMessage = backfillById.get(openingId) ?? null
    // A deleted opener is in `seen` but not in `messages`; falling through to
    // null would show its tombstone from the projection and then drop the row
    // entirely once the rail syncs it.
    if (openingId !== null && rail.seen.has(openingId))
      openingMessage = rail.messages.get(openingId) ?? rail.deletedMessages.get(openingId) ?? null

    if (!conversationSeen && !backfillSeen) {
      // Cold/unsynced: capture a fresh pending row but never drop a live bridge.
      const nextRetained = pendingReplies.length > 0 ? pendingReplies : retained
      return {
        openingMessage,
        replies: post.recentMessages as RenderableMessage[],
        totalReplies: serverTotal,
        pendingReplies,
        source: "projection" as const,
        events: rail.events,
        nextRetained,
      }
    }

    // A soft-deleted member joins the rail's rows as its content-free tombstone:
    // "same data, different view" — a deleted reply reads as deleted on every
    // surface (collapsed card, expanded card, panel) instead of vanishing and
    // silently shifting every row below it up.
    const liveReplies: RenderableMessage[] = []
    for (const id of memberReplyIds) {
      // Precedence: rail (authoritative by id) > backfill store > nothing. The
      // projection never reaches here — it is the whole-card fallback above.
      const message = rail.seen.has(id)
        ? (rail.messages.get(id) ?? rail.deletedMessages.get(id))
        : backfillById?.get(id)
      if (message) liveReplies.push(message)
    }
    liveReplies.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

    // Bridge the convert-to-thread hand-off: when the optimistic reply has left
    // every subscribed rail (`pendingReplies` empty) but the real row hasn't
    // rendered yet, keep showing the retained copy in its place. `bridgeCount`
    // shrinks to zero as the live rows render, so the retained copy never
    // double-renders alongside its confirmed twin, and is forgotten once covered.
    // Tombstones are render-only rows: they can't cover a retained copy, so they
    // must not count against the bridge either.
    const liveUndeletedCount = liveReplies.reduce((n, m) => (m.deletedAt ? n : n + 1), 0)
    const bridgeCount = pendingReplies === NO_PENDING ? Math.max(0, retained.length - liveUndeletedCount) : 0
    const replies =
      bridgeCount > 0
        ? [...liveReplies, ...retained.slice(retained.length - bridgeCount)].sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          )
        : liveReplies

    // When the rail holds every one of this conversation's replies, its displayable
    // (non-deleted) count IS the total — a tombstone is shown but counts as zero, so
    // it must not inflate the "N more" gap. Otherwise trust the server count, but never
    // below what's already on screen (a bridged reply fills its own slot, so it
    // mustn't also leave a phantom "1 more").
    const fullySynced = memberReplyIds.every((id) => rail.seen.has(id) || backfillById?.has(id) === true)
    // `conversation:updated` can land BEFORE the message echo swaps the optimistic
    // row: `messageIds` then lists a real id the rail hasn't seen while the same
    // message is still on screen as a pending row under its client id. Counting
    // that id into the total would pop a phantom "1 more" gap above the very reply
    // it refers to (and flip the run's continuation grouping) for the beat until
    // the echo lands. Discount unseen ids that JOINED `replyIds` during the
    // current pending episode (they can only be in-flight sends or simultaneous
    // arrivals the pending rows visually stand in for), up to the pending row
    // count; ids already listed when the episode began are unsynced older history
    // and keep counting toward the gap.
    const episode = pendingEpisodeRef.current
    const baseline = episode && episode.conversationId === conversationId ? episode.baseline : null
    let episodeArrivals = 0
    if (baseline) for (const id of replyIds) if (!rail.seen.has(id) && !baseline.has(id)) episodeArrivals++
    const covered = Math.min(pendingReplies.length, episodeArrivals)
    const undeletedReplyCount = replies.reduce((n, m) => (m.deletedAt ? n : n + 1), 0)
    const totalReplies = fullySynced ? liveUndeletedCount : Math.max(serverTotal - covered, undeletedReplyCount)

    // Retain a fresh pending row; keep the retained copy while it's still bridging;
    // forget it once the live rows cover it.
    let nextRetained: RenderableMessage[]
    if (pendingReplies.length > 0) nextRetained = pendingReplies
    else if (bridgeCount > 0) nextRetained = retained
    else nextRetained = NO_PENDING

    return {
      openingMessage,
      replies,
      totalReplies,
      pendingReplies,
      source: conversationSeen ? ("events" as const) : ("backfill" as const),
      events: rail.events,
      nextRetained,
    }
  }, [rail, replyIds, openingId, messageIds, post, conversationId, backfillById])

  // Commit the bridge bookkeeping after render, never during it.
  useEffect(() => {
    retainedPendingRef.current = view.nextRetained
    if (view.source !== "projection") lastLiveRef.current = { conversationId, view }
    if (view.pendingReplies.length > 0) {
      const episode = pendingEpisodeRef.current
      // Snapshot only on the 0→N transition — re-snapshotting mid-episode would
      // fold the send's just-arrived id into the baseline and kill its discount.
      if (!episode || episode.conversationId !== conversationId) {
        pendingEpisodeRef.current = { conversationId, baseline: new Set(replyIds) }
      }
    } else {
      pendingEpisodeRef.current = null
    }
  }, [view, conversationId, replyIds])

  const knownMessageIds = useMemo<ReadonlySet<string>>(() => {
    if (!backfillById) return rail.seen
    const set = new Set(rail.seen)
    for (const id of backfillById.keys()) set.add(id)
    return set
  }, [rail.seen, backfillById])

  // Expose the merged rail's message maps so the card can resolve its nested
  // branch conversations' bodies through the same rail (kept off the `view` memo
  // above, whose branches build the card's OWN messages — the rail identity is
  // stable per snapshot, so the branch derivation memoizes on it downstream).
  return useMemo(
    () => ({
      ...view,
      openingMessage: view.openingMessage ? applySettling(view.openingMessage, settlingIds) : null,
      replies: applySettlingAll(view.replies, settlingIds),
      pendingReplies: applySettlingAll(view.pendingReplies, settlingIds),
      messagesById: rail.messages,
      taggedByConversation: rail.taggedByConversation,
      deletedById: rail.deletedMessages,
      settlingIds,
      knownMessageIds,
      railCoversMembership: rail.resolved && railKnowsEveryMember,
    }),
    [
      view,
      settlingIds,
      rail.messages,
      rail.taggedByConversation,
      rail.deletedMessages,
      rail.resolved,
      railKnowsEveryMember,
      knownMessageIds,
    ]
  )
}

/**
 * The collapsed card's reply window: the trailing `RECENT_PREVIEW_CAP` replies
 * at first reveal, then append-only. A new arrival GROWS the window instead of
 * sliding it, so a reply the viewer has seen never drops back under the "N
 * more" gap and rows never move under the eye (INV-61's no-motion rule,
 * extended inside the card). A deleted reply still leaves (a real removal, not
 * instability). A reply that syncs in late — older than the first shown row OR
 * landing between shown rows — stays under the gap: revealing it would push
 * shown rows around, so only rows strictly after the last shown reply append.
 * The shown set resets when the hook instance is recycled onto another
 * conversation.
 */
export function useStableReplyWindow(conversationId: string, replies: RenderableMessage[]): RenderableMessage[] {
  const shownRef = useRef<{ conversationId: string; ids: Set<string> }>({ conversationId, ids: new Set() })

  const window = useMemo(() => {
    const shown = shownRef.current.conversationId === conversationId ? shownRef.current.ids : null
    if (shown) {
      let lastShownIndex = -1
      for (let i = 0; i < replies.length; i++) if (shown.has(replies[i].id)) lastShownIndex = i
      if (lastShownIndex !== -1) {
        return replies.filter((message, index) => shown.has(message.id) || index > lastShownIndex)
      }
    }
    return replies.slice(-RECENT_PREVIEW_CAP)
  }, [conversationId, replies])

  // Record what's shown after commit, never during render (concurrent-safe,
  // same discipline as the pending-reply bridge above).
  useEffect(() => {
    if (shownRef.current.conversationId !== conversationId) {
      shownRef.current = { conversationId, ids: new Set(window.map((message) => message.id)) }
      return
    }
    for (const message of window) shownRef.current.ids.add(message.id)
  }, [conversationId, window])

  return window
}
