import { useLiveQuery } from "dexie-react-hooks"
import { useMemo } from "react"
import { THREAD_ANCHORABLE_EVENT_TYPES } from "@threa/types"
import { db, type CachedBoardPost } from "@/db"
import { parseBoardDraftKey } from "@/lib/board/draft-keys"

export interface BoardDraftContext {
  /** Board post by conversation id: the scopes' own conversations plus the hosts resolved for forks/branches. */
  boardPostMap: Map<string, CachedBoardPost>
  /** Fork message id → the conversation that contains it (a sub-topic draft's host surface). */
  hostPostByMessageId: Map<string, CachedBoardPost>
  /** Branch conversation id → the conversation whose message the branch forks off. */
  parentPostByBranchConversationId: Map<string, CachedBoardPost>
  /**
   * False until the first read resolves. A consumer that HIDES rows on what the
   * maps say (the explorer's archived filter) must hold while this is false —
   * an unresolved conversation is indistinguishable from one with no archived
   * host, so acting on the empty default renders the row and then retracts it.
   */
  loaded: boolean
}

const EMPTY_CONTEXT: BoardDraftContext = {
  boardPostMap: new Map(),
  hostPostByMessageId: new Map(),
  parentPostByBranchConversationId: new Map(),
  loaded: false,
}

/** Stable signature over a set of draft scopes — the gate every query below keys on. */
export function draftScopesSignature(scopes: Iterable<string>): string {
  return [...new Set(scopes)].sort().join("|")
}

interface ScopeKeys {
  conversationIdKey: string
  branchConversationIdKey: string
  subtopicMessageIdKey: string
}

function scopeKeys(scopesSignature: string): ScopeKeys {
  const conversationIds = new Set<string>()
  const branchConversationIds = new Set<string>()
  const subtopicMessageIds = new Set<string>()
  for (const scope of scopesSignature.split("|")) {
    const parsed = parseBoardDraftKey(scope)
    if (!parsed) continue
    if (parsed.kind === "subtopic") subtopicMessageIds.add(parsed.messageId)
    else conversationIds.add(parsed.conversationId)
    if (parsed.kind === "branch-reply") branchConversationIds.add(parsed.conversationId)
  }
  return {
    conversationIdKey: [...conversationIds].sort().join(","),
    branchConversationIdKey: [...branchConversationIds].sort().join(","),
    subtopicMessageIdKey: [...subtopicMessageIds].sort().join(","),
  }
}

// Sub-topic drafts name only their fork message; branch drafts name a child
// conversation whose parent must be derived structurally (its anchor thread's
// parent message → the conversation holding it — sub-topic conversations carry
// no `parentConversationId`). Both resolve to the HOSTING conversation the
// explorer deep-links to, since that surface hosts the draft's composer.
async function loadBoardDraftContext(workspaceId: string, keys: ScopeKeys): Promise<BoardDraftContext> {
  const { conversationIdKey, branchConversationIdKey, subtopicMessageIdKey } = keys
  if (!conversationIdKey && !subtopicMessageIdKey) return { ...EMPTY_CONTEXT, loaded: true }

  const convIds = conversationIdKey ? conversationIdKey.split(",") : []
  const branchIds = new Set(branchConversationIdKey ? branchConversationIdKey.split(",") : [])
  const referencedRows = convIds.length > 0 ? await db.conversations.bulkGet(convIds) : []
  const referenced = referencedRows.filter(
    (row): row is CachedBoardPost => row !== undefined && row.workspaceId === workspaceId
  )

  const forkMessageIds = new Set(subtopicMessageIdKey ? subtopicMessageIdKey.split(",") : [])
  const branchPosts = referenced.filter((row) => branchIds.has(row.id))
  const threadRows =
    branchPosts.length > 0 ? await db.streams.bulkGet(branchPosts.map((row) => row.conversation.streamId)) : []
  const forkByBranchConversationId = new Map<string, string>()
  branchPosts.forEach((row, i) => {
    const forkAnchorId = threadRows[i]?.parentAnchorId ?? threadRows[i]?.parentMessageId
    if (forkAnchorId) {
      forkByBranchConversationId.set(row.id, forkAnchorId)
      forkMessageIds.add(forkAnchorId)
    }
  })

  const hostPostByMessageId = new Map<string, CachedBoardPost>()
  let hostRows: CachedBoardPost[] = []
  if (forkMessageIds.size > 0) {
    // The v48 multiEntry index over `conversation.messageIds` — a keyed lookup
    // per fork id instead of a scan of every conversation in the workspace.
    // `distinct()` because a conversation holding two of the ids would otherwise
    // come back once per match.
    hostRows = (
      await db.conversations
        .where("conversation.messageIds")
        .anyOf([...forkMessageIds])
        .distinct()
        .toArray()
    ).filter((row) => row.workspaceId === workspaceId)
    for (const post of hostRows) {
      for (const id of post.conversation.messageIds ?? []) {
        if (forkMessageIds.has(id)) hostPostByMessageId.set(id, post)
      }
    }
  }
  const parentPostByBranchConversationId = new Map<string, CachedBoardPost>()
  for (const [branchId, forkId] of forkByBranchConversationId) {
    const host = hostPostByMessageId.get(forkId)
    if (host) parentPostByBranchConversationId.set(branchId, host)
  }

  const boardPostMap = new Map<string, CachedBoardPost>()
  for (const post of [...referenced, ...hostRows]) boardPostMap.set(post.id, post)
  return { boardPostMap, hostPostByMessageId, parentPostByBranchConversationId, loaded: true }
}

/**
 * Resolved values held across remounts, keyed by `workspace|kind|signature`. A
 * remount re-runs the query from `undefined`, and falling back to the empty
 * default would report `loaded: false` again — a consumer holding its UI on that
 * flag blinks on every warm navigation, though the value it is about to
 * re-resolve to is the one held here. The signature is part of the key, not a
 * check against a single slot: the sidebar, the explorer and every mounted
 * composer read this with DIFFERENT signatures at the same time, and one shared
 * slot would have them evict each other's entry on every write. Bounded, since
 * a signature changes with the draft set: oldest key out past the cap.
 */
const RETAINED_CONTEXTS = 8
const lastResolved = new Map<string, unknown>()

function rememberResolved<T>(key: string, value: T): T {
  lastResolved.delete(key)
  lastResolved.set(key, value)
  if (lastResolved.size > RETAINED_CONTEXTS) {
    const oldest = lastResolved.keys().next()
    if (!oldest.done) lastResolved.delete(oldest.value)
  }
  return value
}

function recallResolved<T>(key: string, empty: T): T {
  const held = lastResolved.get(key)
  return held === undefined ? empty : (held as T)
}

/** Drop retained context values (account switch, tests). */
export function resetDraftContextCache(): void {
  lastResolved.clear()
}

/**
 * `useLiveQuery` keeps serving the PREVIOUS deps' result while the query for the
 * new ones is still in flight — its internal "has a result" latch is set once and
 * never reset. A consumer reading `loaded` off that value would take a context
 * resolved for the ids it just left as resolved for the ids it now asks about,
 * and decide (say) that no host is archived. The stamp is what separates
 * "resolved for these ids" from "resolved for the ones we left".
 */
function stamp<T>(key: string, value: T): { key: string; value: T } {
  return { key, value }
}

function readStamped<T>(live: { key: string; value: T } | undefined, key: string, empty: T): T {
  if (live?.key === key) return live.value
  return recallResolved(key, empty)
}

/**
 * The cached conversations a set of `board:*` draft scopes references, resolved
 * once for every consumer (the drafts explorer's location labels, the composer
 * pile's landing sites) so the two can't drift (INV-35). Keyed on the ids the
 * scopes reference, never on the drafts array, so a keystroke's draft write
 * doesn't re-fire it — the property an always-mounted composer depends on.
 */
export function useBoardDraftContext(workspaceId: string, scopesSignature: string): BoardDraftContext {
  const keys = useMemo(() => scopeKeys(scopesSignature), [scopesSignature])
  const retentionKey = `${workspaceId}|board|${scopesSignature}`
  const live = useLiveQuery(
    async () => stamp(retentionKey, rememberResolved(retentionKey, await loadBoardDraftContext(workspaceId, keys))),
    [workspaceId, keys]
  )
  return readStamped(live, retentionKey, EMPTY_CONTEXT)
}

/**
 * What a set of thread/card anchor ids resolves to: the stream holding the
 * anchored row (a `thread:` draft's home) and the conversation that owns it (the
 * pile's same-conversation route).
 */
export interface ThreadAnchorContext {
  /** Anchor id → the stream holding the anchored message/card. */
  streamByAnchorId: Map<string, { streamId: string; anchorId: string }>
  /** Anchor id → the conversation that contains it, where one is cached. */
  conversationIdByAnchorId: Map<string, string>
  /** False until the first read resolves — see {@link BoardDraftContext.loaded}. */
  loaded: boolean
}

const EMPTY_ANCHOR_CONTEXT: ThreadAnchorContext = {
  streamByAnchorId: new Map(),
  conversationIdByAnchorId: new Map(),
  loaded: false,
}

// Both reads are keyed lookups over the ids actually referenced: the sparse
// `payload.messageId` index (v47) for message anchors, the primary key for card
// anchors and for the conversation-backfill rows. Nothing scans the events table
// or the whole workspace, so an always-mounted composer's subscription re-fires
// only on writes touching an id it asked for.
async function loadThreadAnchorContext(workspaceId: string, anchorIdKey: string): Promise<ThreadAnchorContext> {
  if (!anchorIdKey) return { ...EMPTY_ANCHOR_CONTEXT, loaded: true }
  const anchorIds = anchorIdKey.split("|")

  const streamByAnchorId = new Map<string, { streamId: string; anchorId: string }>()
  const messageRows = await db.events.where("payload.messageId").anyOf(anchorIds).toArray()
  for (const event of messageRows) {
    if (event.eventType !== "message_created") continue
    if (event.workspaceId != null && event.workspaceId !== workspaceId) continue
    const messageId = (event.payload as { messageId?: string }).messageId
    if (messageId) streamByAnchorId.set(messageId, { streamId: event.streamId, anchorId: messageId })
  }
  const cardRows = await db.events.bulkGet(anchorIds)
  for (const event of cardRows) {
    if (!event || !THREAD_ANCHORABLE_EVENT_TYPES.includes(event.eventType)) continue
    if (event.workspaceId != null && event.workspaceId !== workspaceId) continue
    streamByAnchorId.set(event.id, { streamId: event.streamId, anchorId: event.id })
  }

  const conversationIdByAnchorId = new Map<string, string>()
  const conversationRows = await db.conversationMessages.bulkGet(anchorIds)
  for (const row of conversationRows) {
    if (row?.workspaceId === workspaceId) conversationIdByAnchorId.set(row.messageId, row.conversationId)
  }

  return { streamByAnchorId, conversationIdByAnchorId, loaded: true }
}

/**
 * The cached rows a set of anchor ids points at, resolved once for every
 * consumer (the drafts explorer, the sidebar badge, the composer pile). The
 * signature is the anchor ids themselves, so a keystroke's draft write doesn't
 * re-fire it and an anchor nobody references is never read.
 */
export function useThreadAnchorContext(workspaceId: string, anchorIdsSignature: string): ThreadAnchorContext {
  const retentionKey = `${workspaceId}|thread|${anchorIdsSignature}`
  const live = useLiveQuery(
    async () =>
      stamp(
        retentionKey,
        rememberResolved(retentionKey, await loadThreadAnchorContext(workspaceId, anchorIdsSignature))
      ),
    [workspaceId, anchorIdsSignature]
  )
  return readStamped(live, retentionKey, EMPTY_ANCHOR_CONTEXT)
}
