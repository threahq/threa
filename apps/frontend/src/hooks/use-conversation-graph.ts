import { useCallback, useSyncExternalStore } from "react"
import { liveQuery, type Subscription } from "dexie"
import { StreamTypes } from "@threa/types"
import { db, type CachedBoardPost, type CachedStream } from "@/db"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { streamLabel } from "@/lib/streams"
import { effectiveConversationTitle } from "@/lib/conversations/title"
import type { RenderableMessage } from "@/components/message/message-item"
import type { BranchConversationView } from "@/lib/board/branch-grouping"
import { applySettlingAll } from "@/hooks/use-board-card-messages"

/**
 * The board's cross-conversation lookups, derived once per workspace from the
 * cached conversations and shared across every card:
 *
 * - `conversationByAnchorStreamId` — the conversation anchored to a **thread**
 *   stream. Only thread-anchored conversations are indexed (a channel/DM anchor
 *   is shared by many conversations), so a parent card can resolve the child
 *   conversation a fork thread hosts. `rootStreamId !== anchor` marks the thread
 *   anchor (a top-level anchor is its own root).
 * - `conversationIdByMemberMessageId` — the conversation each message is a primary
 *   member of, so a child card can find the parent conversation its opener thread
 *   forked from.
 * - `conversationById` — resolve a looked-up id back to its post (topic/anchor).
 */
export interface ConversationGraph {
  conversationByAnchorStreamId: Map<string, CachedBoardPost>
  conversationIdByMemberMessageId: Map<string, string>
  conversationById: Map<string, CachedBoardPost>
}

const EMPTY_GRAPH: ConversationGraph = {
  conversationByAnchorStreamId: new Map(),
  conversationIdByMemberMessageId: new Map(),
  conversationById: new Map(),
}

export function buildConversationGraph(posts: CachedBoardPost[]): ConversationGraph {
  return buildGraph(posts)
}

function buildGraph(posts: CachedBoardPost[]): ConversationGraph {
  const conversationByAnchorStreamId = new Map<string, CachedBoardPost>()
  const conversationIdByMemberMessageId = new Map<string, string>()
  const conversationById = new Map<string, CachedBoardPost>()
  for (const post of posts) {
    conversationById.set(post.id, post)
    const anchor = post.conversation.streamId
    if (post.rootStreamId !== undefined && post.rootStreamId !== anchor) {
      conversationByAnchorStreamId.set(anchor, post)
    }
    for (const messageId of post.conversation.messageIds ?? []) conversationIdByMemberMessageId.set(messageId, post.id)
  }
  return { conversationByAnchorStreamId, conversationIdByMemberMessageId, conversationById }
}

interface GraphEntry {
  graph: ConversationGraph
  /** False until the first IDB read emits — the board's reveal gate holds first
   *  paint on it so branch nesting is present from the very first frame. */
  resolved: boolean
  listeners: Set<() => void>
  subscription: Subscription
  refCount: number
}

// INV-9 exception: one shared `db.conversations` liveQuery per workspace,
// ref-counted across every board card. The board renders hundreds of cards over
// hundreds of conversations; a per-card scan for "which conversation anchors this
// thread / owns this message" would be O(cards × conversations). This collapses
// it to one liveQuery per workspace whose derived index every card reads, torn
// down when the last card unmounts (adjustment E). Mirrors `threadIndexRegistry`.
const graphRegistry = new Map<string, GraphEntry>()

function subscribeConversationGraph(workspaceId: string, listener: () => void): () => void {
  let entry = graphRegistry.get(workspaceId)
  if (!entry) {
    const created: GraphEntry = {
      graph: EMPTY_GRAPH,
      resolved: false,
      listeners: new Set(),
      refCount: 0,
      subscription: { unsubscribe() {} } as Subscription,
    }
    // Register BEFORE subscribing so `getSnapshot` observes the entry consistently;
    // the callback re-reads the live entry so a late emission after teardown no-ops.
    graphRegistry.set(workspaceId, created)
    created.subscription = liveQuery(() =>
      db.conversations.where("workspaceId").equals(workspaceId).toArray()
    ).subscribe((posts) => {
      const live = graphRegistry.get(workspaceId)
      if (!live) return
      live.graph = buildGraph(posts)
      live.resolved = true
      for (const notify of live.listeners) notify()
    })
    entry = created
  }
  entry.listeners.add(listener)
  entry.refCount += 1
  return () => {
    const current = graphRegistry.get(workspaceId)
    if (!current) return
    current.listeners.delete(listener)
    current.refCount -= 1
    if (current.refCount <= 0) {
      current.subscription.unsubscribe()
      graphRegistry.delete(workspaceId)
    }
  }
}

/** The shared conversation graph for a workspace, live from `db.conversations`. */
export function useConversationGraph(workspaceId: string): ConversationGraph {
  const subscribe = useCallback(
    (onChange: () => void) => subscribeConversationGraph(workspaceId, onChange),
    [workspaceId]
  )
  const getSnapshot = useCallback(() => graphRegistry.get(workspaceId)?.graph ?? EMPTY_GRAPH, [workspaceId])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** Whether the shared graph's first IDB read has landed. Part of the board's
 *  coordinated reveal: cards must not take their first paint against
 *  `EMPTY_GRAPH`, or branch nesting pops in a frame later. */
export function useConversationGraphReady(workspaceId: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => subscribeConversationGraph(workspaceId, onChange),
    [workspaceId]
  )
  const getSnapshot = useCallback(() => graphRegistry.get(workspaceId)?.resolved ?? false, [workspaceId])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** The board's structural stream index — parent pointers (for depth/branch
 *  grouping) and threads keyed by their fork message (for stub discovery). */
export interface StreamStructuralIndex {
  streamsById: Map<string, CachedStream>
  /**
   * Threads keyed by their anchor id (`parentAnchorId ?? parentMessageId`). Board
   * branches fork off MESSAGES, so event-anchored (card) threads are excluded — a
   * card's discussion is never a board branch. Keeping the map free of card
   * anchors makes the board's message-only assumption explicit at the build site.
   */
  threadsByAnchorId: Map<string, CachedStream>
}

// Cached by the raw streams array identity so every card shares one build; the
// raw array reference is stable across cards until `db.streams` changes.
const structuralIndexCache = new WeakMap<CachedStream[], StreamStructuralIndex>()

function computeStructuralIndex(streams: CachedStream[]): StreamStructuralIndex {
  const cached = structuralIndexCache.get(streams)
  if (cached) return cached
  const streamsById = new Map<string, CachedStream>()
  const threadsByAnchorId = new Map<string, CachedStream>()
  for (const stream of streams) {
    streamsById.set(stream.id, stream)
    if (stream.type !== StreamTypes.THREAD) continue
    const anchorId = stream.parentAnchorId ?? stream.parentMessageId
    // Board branches fork off MESSAGES; exclude event-anchored (card) threads so
    // the board's message-only assumption is explicit at the index build site.
    if (anchorId && !anchorId.startsWith("event_")) threadsByAnchorId.set(anchorId, stream)
  }
  const index = { streamsById, threadsByAnchorId }
  structuralIndexCache.set(streams, index)
  return index
}

export function useStreamStructuralIndex(workspaceId: string): StreamStructuralIndex {
  const streams = useWorkspaceStreams(workspaceId)
  return computeStructuralIndex(streams)
}

/**
 * The branch relationship, resolved from the graph alone: the parent conversation
 * a `conversationId`'s anchor thread forks off, or `null` when it isn't a branch
 * (anchor isn't a thread, its fork message belongs to no conversation, or that
 * conversation is empty/itself). The single walk primitive shared by the child
 * card's "branched from" provenance, the parent card's nested discovery, and the
 * board list's one-card-per-root suppression — so all three read the same rule.
 */
export function resolveParentConversationId(params: {
  conversationId: string
  anchorStreamId: string
  index: StreamStructuralIndex
  graph: ConversationGraph
}): string | null {
  const { conversationId, anchorStreamId, index, graph } = params
  const anchor = index.streamsById.get(anchorStreamId)
  // The fork the branch hangs off is this thread's anchor. A card anchor (event_)
  // never matches a message-keyed conversation membership, so it resolves to no
  // parent naturally — the board's message-only assumption without an extra guard.
  const anchorId = anchor?.parentAnchorId ?? anchor?.parentMessageId
  if (!anchor || anchor.type !== StreamTypes.THREAD || !anchorId) return null
  const parentId = graph.conversationIdByMemberMessageId.get(anchorId)
  if (!parentId || parentId === conversationId) return null
  const parentPost = graph.conversationById.get(parentId)
  if (!parentPost || parentPost.conversation.messageIds.length === 0) return null
  return parentId
}

/** {@link resolveParentConversationId} keyed by id alone — the board list
 *  suppression's transitive walk resolves ancestors it holds no post object for
 *  (a middle parent filtered out of the current lens) straight off the graph. */
export function branchParentConversationId(
  conversationId: string,
  index: StreamStructuralIndex,
  graph: ConversationGraph
): string | null {
  const post = graph.conversationById.get(conversationId)
  if (!post) return null
  return resolveParentConversationId({ conversationId, anchorStreamId: post.conversation.streamId, index, graph })
}

/** Whether any of `memberMessageIds` opens a further non-empty branch conversation
 *  — the depth-cap overflow signal (a grandchild that itself branches links out
 *  instead of nesting a third level). */
function hasDeeperBranch(
  memberMessageIds: string[],
  index: StreamStructuralIndex,
  graph: ConversationGraph,
  seenConversationIds: Set<string>
): boolean {
  for (const messageId of memberMessageIds) {
    const thread = index.threadsByAnchorId.get(messageId)
    if (!thread) continue
    const childPost = graph.conversationByAnchorStreamId.get(thread.id)
    if (childPost && !seenConversationIds.has(childPost.id) && childPost.conversation.messageIds.length > 0) return true
  }
  return false
}

/**
 * The branch conversations nested inside a parent card, discovered recursively
 * from the stream graph (Kris dogfood ruling 2026-07-05):
 * for each of the parent's member messages, the thread forking off it that
 * anchors another non-empty conversation becomes a branch; that child's own
 * member messages are walked for grandchildren, capped at `maxDepth` (deeper
 * subtrees collapse to a `continue in panel` link via the `overflow` flag).
 *
 * Structure comes from the graph (server-known `messageIds`); message BODIES come
 * from `resolveMessages`, which reads the parent card's merged rail (and slices to
 * the collapsed window, returning `hiddenCount`). `seenConversationIds` guards
 * against a cycle re-nesting a conversation already on the path.
 */
export function deriveBranchConversations(params: {
  conversationId: string
  memberMessageIds: string[]
  index: StreamStructuralIndex
  graph: ConversationGraph
  resolveMessages: (
    conversationId: string,
    memberMessageIds: string[]
  ) => { messages: RenderableMessage[]; hiddenCount: number }
  /** Threads the parent conversation itself occupies — those render inline
   *  (soft/spanning nodes), never doubled as a branch group (mixed membership). */
  excludeThreadStreamIds?: Set<string>
  maxDepth?: number
}): BranchConversationView[] {
  const {
    conversationId,
    memberMessageIds,
    index,
    graph,
    resolveMessages,
    excludeThreadStreamIds,
    maxDepth = 2,
  } = params
  const walk = (forkCandidateIds: string[], depth: number, seen: Set<string>): BranchConversationView[] => {
    const out: BranchConversationView[] = []
    const seenFork = new Set<string>()
    for (const messageId of forkCandidateIds) {
      if (seenFork.has(messageId)) continue
      seenFork.add(messageId)
      const thread = index.threadsByAnchorId.get(messageId)
      if (!thread || excludeThreadStreamIds?.has(thread.id)) continue
      const childPost = graph.conversationByAnchorStreamId.get(thread.id)
      if (!childPost || seen.has(childPost.id) || childPost.conversation.messageIds.length === 0) continue
      const childConversationId = childPost.id
      const nextSeen = new Set(seen).add(childConversationId)
      const childMemberIds = childPost.conversation.messageIds
      const { messages, hiddenCount } = resolveMessages(childConversationId, childMemberIds)
      // The rail's rows carry no settling state (it's board-post scoped), and the
      // parent's set doesn't cover a child's members — so the mark is stamped
      // here, from the child post in hand. Without it the same message reads
      // settled inside the parent's card and settling on its own card.
      const settlingMessageIds = childPost.settlingMessageIds ?? []
      const markedMessages = settlingMessageIds.length
        ? applySettlingAll(messages, new Set(settlingMessageIds))
        : messages
      const title = effectiveConversationTitle(childPost.conversation, thread) || streamLabel(thread, "generic")
      const children = depth < maxDepth ? walk(childMemberIds, depth + 1, nextSeen) : []
      const overflow = depth >= maxDepth && hasDeeperBranch(childMemberIds, index, graph, nextSeen)
      out.push({
        conversationId: childConversationId,
        threadStreamId: thread.id,
        forkMessageId: messageId,
        title,
        displayDepth: depth,
        overflow,
        messages: markedMessages,
        memberMessageIds: [...new Set([...childMemberIds, ...markedMessages.map((m) => m.id)])],
        settlingMessageIds,
        hiddenCount,
        children,
      })
    }
    return out
  }
  return walk(memberMessageIds, 1, new Set([conversationId]))
}

/** Every branch thread stream a parent card renders, flattened from the graph
 *  alone (no rail) so the card can subscribe to them ahead of resolving their
 *  bodies. Mirrors {@link deriveBranchConversations}' walk. */
export function collectBranchThreadStreamIds(params: {
  conversationId: string
  memberMessageIds: string[]
  index: StreamStructuralIndex
  graph: ConversationGraph
  maxDepth?: number
}): string[] {
  const { conversationId, memberMessageIds, index, graph, maxDepth = 2 } = params
  const out = new Set<string>()
  const walk = (forkCandidateIds: string[], depth: number, seen: Set<string>) => {
    if (depth > maxDepth) return
    const seenFork = new Set<string>()
    for (const messageId of forkCandidateIds) {
      if (seenFork.has(messageId)) continue
      seenFork.add(messageId)
      const thread = index.threadsByAnchorId.get(messageId)
      if (!thread) continue
      const childPost = graph.conversationByAnchorStreamId.get(thread.id)
      if (!childPost || seen.has(childPost.id) || childPost.conversation.messageIds.length === 0) continue
      out.add(thread.id)
      const nextSeen = new Set(seen).add(childPost.id)
      if (depth < maxDepth) walk(childPost.conversation.messageIds, depth + 1, nextSeen)
    }
  }
  walk(memberMessageIds, 1, new Set([conversationId]))
  return [...out]
}

/**
 * "Branched from …" provenance for a child card: present iff the conversation's
 * opener stream is a thread whose fork message is a member of another non-empty
 * conversation.
 */
export function deriveBranchProvenance(params: {
  conversationId: string
  anchorStreamId: string
  index: StreamStructuralIndex
  graph: ConversationGraph
}): { parentConversationId: string; title: string } | null {
  const parentId = resolveParentConversationId(params)
  if (!parentId) return null
  const parentPost = params.graph.conversationById.get(parentId)!
  const parentAnchor = params.index.streamsById.get(parentPost.conversation.streamId)
  const title =
    effectiveConversationTitle(parentPost.conversation, parentAnchor) ||
    (parentAnchor ? streamLabel(parentAnchor, "generic") : "conversation")
  return { parentConversationId: parentId, title }
}

/** Tear down every shared conversation-graph subscription — for tests, so a
 *  module-level registry can't leak a liveQuery (or a snapshot) across cases. */
export function __clearConversationGraphRegistry(): void {
  for (const entry of graphRegistry.values()) entry.subscription.unsubscribe()
  graphRegistry.clear()
}
