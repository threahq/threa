import { useCallback, useSyncExternalStore } from "react"
import { liveQuery, type Subscription } from "dexie"
import { StreamTypes } from "@threa/types"
import { db, type CachedBoardPost, type CachedStream } from "@/db"
import { useWorkspaceStreamsRaw } from "@/stores/workspace-store"
import { streamLabel } from "@/lib/streams"
import { stripMarkdownToInline } from "@/lib/markdown/strip"
import type { RenderableMessage } from "@/components/message/message-item"
import type { BranchStub } from "@/lib/board/branch-grouping"

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
    for (const messageId of post.conversation.messageIds) conversationIdByMemberMessageId.set(messageId, post.id)
  }
  return { conversationByAnchorStreamId, conversationIdByMemberMessageId, conversationById }
}

interface GraphEntry {
  graph: ConversationGraph
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

/** The board's structural stream index — parent pointers (for depth/branch
 *  grouping) and threads keyed by their fork message (for stub discovery). */
export interface StreamStructuralIndex {
  streamsById: Map<string, CachedStream>
  threadsByParentMessageId: Map<string, CachedStream>
}

// Cached by the raw streams array identity so every card shares one build; the
// raw array reference is stable across cards until `db.streams` changes.
const structuralIndexCache = new WeakMap<CachedStream[], StreamStructuralIndex>()

function computeStructuralIndex(streams: CachedStream[]): StreamStructuralIndex {
  const cached = structuralIndexCache.get(streams)
  if (cached) return cached
  const streamsById = new Map<string, CachedStream>()
  const threadsByParentMessageId = new Map<string, CachedStream>()
  for (const stream of streams) {
    streamsById.set(stream.id, stream)
    if (stream.type === StreamTypes.THREAD && stream.parentMessageId) {
      threadsByParentMessageId.set(stream.parentMessageId, stream)
    }
  }
  const index = { streamsById, threadsByParentMessageId }
  structuralIndexCache.set(streams, index)
  return index
}

export function useStreamStructuralIndex(workspaceId: string): StreamStructuralIndex {
  const streams = useWorkspaceStreamsRaw(workspaceId)
  return computeStructuralIndex(streams)
}

/**
 * True-thread stubs for a parent card: for each of the conversation's member
 * messages, a fork thread whose stream the conversation does NOT occupy (none of
 * its messages are members — soft threads render inline, adjustment D) and which
 * anchors another conversation. Keyed by fork message id for placement.
 */
export function deriveBranchStubs(params: {
  conversationId: string
  memberMessages: RenderableMessage[]
  occupiedStreamIds: Set<string>
  index: StreamStructuralIndex
  graph: ConversationGraph
}): Map<string, BranchStub[]> {
  const { conversationId, memberMessages, occupiedStreamIds, index, graph } = params
  const stubs = new Map<string, BranchStub[]>()
  const seen = new Set<string>()
  for (const message of memberMessages) {
    if (seen.has(message.id)) continue
    seen.add(message.id)
    const thread = index.threadsByParentMessageId.get(message.id)
    if (!thread || occupiedStreamIds.has(thread.id)) continue
    const childPost = graph.conversationByAnchorStreamId.get(thread.id)
    if (!childPost || childPost.id === conversationId) continue
    const title = stripMarkdownToInline(childPost.conversation.topicSummary ?? "") || streamLabel(thread, "generic")
    stubs.set(message.id, [
      { forkMessageId: message.id, childConversationId: childPost.id, threadStreamId: thread.id, title },
    ])
  }
  return stubs
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
  const { conversationId, anchorStreamId, index, graph } = params
  const anchor = index.streamsById.get(anchorStreamId)
  if (!anchor || anchor.type !== StreamTypes.THREAD || !anchor.parentMessageId) return null
  const parentId = graph.conversationIdByMemberMessageId.get(anchor.parentMessageId)
  if (!parentId || parentId === conversationId) return null
  const parentPost = graph.conversationById.get(parentId)
  if (!parentPost || parentPost.conversation.messageIds.length === 0) return null
  const parentAnchor = index.streamsById.get(parentPost.conversation.streamId)
  const title =
    stripMarkdownToInline(parentPost.conversation.topicSummary ?? "") ||
    (parentAnchor ? streamLabel(parentAnchor, "generic") : "conversation")
  return { parentConversationId: parentId, title }
}

/** Tear down every shared conversation-graph subscription — for tests, so a
 *  module-level registry can't leak a liveQuery (or a snapshot) across cases. */
export function __clearConversationGraphRegistry(): void {
  for (const entry of graphRegistry.values()) entry.subscription.unsubscribe()
  graphRegistry.clear()
}
