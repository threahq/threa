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
 *  member's stream and merges them by id. `gatingCount` is how many of the leading
 *  rails are server-known member streams that gate `resolved`; rails past it are
 *  opportunistically-discovered threads (and the optimistic draft panel) that
 *  CONTRIBUTE content but must not drag the card back to its projection while they
 *  load — otherwise discovering a new thread re-flashes an already-live card. */
function mergeRails(rails: StreamRail[], gatingCount: number): StreamRail {
  if (rails.length === 1) return rails[0]
  const messages = new Map<string, RenderableMessage>()
  const seen = new Set<string>()
  const taggedByConversation = new Map<string, RenderableMessage[]>()
  // Resolved once every GATING rail has read — a still-loading discovered thread
  // doesn't count, so the card keeps its live view instead of dropping to the
  // projection the instant a thread appears.
  let resolved = true
  rails.forEach((rail, i) => {
    if (i < gatingCount && !rail.resolved) resolved = false
    for (const [id, message] of rail.messages) messages.set(id, message)
    for (const id of rail.seen) seen.add(id)
    for (const [conversationId, list] of rail.taggedByConversation) {
      const existing = taggedByConversation.get(conversationId)
      if (existing) existing.push(...list)
      else taggedByConversation.set(conversationId, [...list])
    }
  })
  for (const list of taggedByConversation.values()) {
    list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }
  return { messages, seen, taggedByConversation, resolved }
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
function useMergedStreamRail(gatingStreamIds: string[], extraStreamIds: string[]): StreamRail {
  const gatingCount = gatingStreamIds.length
  const gatingKey = gatingStreamIds.join(",")
  const extraKey = extraStreamIds.join(",")
  const streamIds = useMemo(() => [...gatingStreamIds, ...extraStreamIds], [gatingKey, extraKey])
  const key = gatingKey + "|" + extraKey
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
      for (const thread of threads) if (thread.parentMessageId) byParent.set(thread.parentMessageId, thread.id)
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

/** Tear down every shared stream subscription — for tests, so a module-level
 *  registry can't leak a liveQuery (or a snapshot) across cases. */
export function __clearBoardRailRegistry(): void {
  for (const entry of railRegistry.values()) entry.subscription.unsubscribe()
  railRegistry.clear()
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
    const set = new Set<string>([streamId])
    for (const id of post.streamIds ?? []) set.add(id)
    if (openingStreamId) set.add(openingStreamId)
    for (const message of post.recentMessages) if (message.streamId) set.add(message.streamId)
    return [...set].sort()
  }, [streamId, streamIdsKey, openingStreamId, recentStreamsKey])
  const gatingKey = gatingStreamIds.join(",")
  const extraStreamIds = useMemo(() => {
    const gating = new Set(gatingStreamIds)
    const set = new Set<string>()
    for (const id of childThreadIds) if (!gating.has(id)) set.add(id)
    if (threadable && messageIds.length <= 1 && openingId) {
      const panel = createDraftPanelId(streamId, openingId)
      if (!gating.has(panel)) set.add(panel)
    }
    return [...set].sort()
  }, [childThreadKey, gatingKey, threadable, messageIdsKey, openingId, streamId])

  const rail = useMergedStreamRail(gatingStreamIds, extraStreamIds)
  const conversationId = post.conversation.id
  // The viewer's just-sent reply, kept alive across the convert-to-thread hand-off.
  // When a lone post's first reply lands, its optimistic row is swapped onto a
  // freshly-created thread stream the card is still catching up to, and for a beat
  // it's also absent from `messageIds` — so it belongs to no subscribed rail and
  // would blink out / collapse under "1 more". Holding the last-shown copy bridges
  // that window until the real row renders.
  const retainedPendingRef = useRef<RenderableMessage[]>(NO_PENDING)

  return useMemo(() => {
    // Replies for this conversation the card knows from the rail but the server
    // `messageIds` doesn't list yet — the optimistic row, and the swapped real
    // row in the window before `conversation:updated` lands. Exclude ids already
    // in `replyIds` so a confirmed reply renders once (via `replies`), not twice.
    const replyIdSet = new Set(replyIds)
    const tagged = rail.taggedByConversation.get(conversationId)
    const unconfirmed = tagged ? tagged.filter((m) => !replyIdSet.has(m.id)) : NO_PENDING
    const pendingReplies = unconfirmed.length > 0 ? unconfirmed : NO_PENDING
    if (pendingReplies !== NO_PENDING) retainedPendingRef.current = pendingReplies

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

    // Bridge the convert-to-thread hand-off: when the optimistic reply has left
    // every subscribed rail (`pendingReplies` empty) but the real row hasn't
    // rendered yet, keep showing the retained copy in its place. `bridgeCount`
    // shrinks to zero as the live rows render, so the retained copy never
    // double-renders alongside its confirmed twin, and is forgotten once covered.
    const retained = retainedPendingRef.current
    const bridgeCount = pendingReplies === NO_PENDING ? Math.max(0, retained.length - liveReplies.length) : 0
    if (bridgeCount === 0 && pendingReplies === NO_PENDING) retainedPendingRef.current = NO_PENDING
    const replies =
      bridgeCount > 0
        ? [...liveReplies, ...retained.slice(retained.length - bridgeCount)].sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          )
        : liveReplies

    // When the rail holds every one of this conversation's replies, its displayable
    // (non-deleted) count IS the total — a tombstone is "seen" but not shown, so it
    // must not inflate the "N more" gap. Otherwise trust the server count, but never
    // below what's already on screen (a bridged reply fills its own slot, so it
    // mustn't also leave a phantom "1 more").
    const fullySynced = replyIds.every((id) => rail.seen.has(id))
    const totalReplies = fullySynced ? liveReplies.length : Math.max(serverTotal, replies.length)

    return { openingMessage, replies, totalReplies, pendingReplies, source: "events" }
  }, [rail, replyIds, openingId, messageIds, post, conversationId])
}
