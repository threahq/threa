import { liveQuery, type Subscription } from "dexie"
import { useCallback, useMemo, useSyncExternalStore } from "react"
import { db, type CachedBoardPost } from "@/db"
import { parseBoardDraftKey } from "@/lib/board/draft-keys"

export interface BoardDraftContext {
  /** Board post by conversation id: the scopes' own conversations plus the hosts resolved for forks/branches. */
  boardPostMap: Map<string, CachedBoardPost>
  /** Fork message id → the conversation that contains it (a sub-topic draft's host surface). */
  hostPostByMessageId: Map<string, CachedBoardPost>
  /** Branch conversation id → the conversation whose message the branch forks off. */
  parentPostByBranchConversationId: Map<string, CachedBoardPost>
}

const EMPTY_CONTEXT: BoardDraftContext = {
  boardPostMap: new Map(),
  hostPostByMessageId: new Map(),
  parentPostByBranchConversationId: new Map(),
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
  if (!conversationIdKey && !subtopicMessageIdKey) return EMPTY_CONTEXT

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
    const rows = await db.conversations.where("workspaceId").equals(workspaceId).toArray()
    hostRows = rows.filter((row) => row.conversation.messageIds?.some((id: string) => forkMessageIds.has(id)))
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
  return { boardPostMap, hostPostByMessageId, parentPostByBranchConversationId }
}

interface BoardDraftContextEntry {
  context: BoardDraftContext
  listeners: Set<() => void>
  subscription: Subscription
  refCount: number
}

// INV-9 exception: one shared liveQuery per (workspace, referenced-id set),
// ref-counted like `boardDraftsRegistry` in `use-scope-draft-preview.ts`. Two
// consumers — the drafts explorer's location labels and the composer pile's
// landing sites — mount this at once, and a per-mount `useLiveQuery` would run
// the whole read (including the workspace-wide conversations scan the fork path
// takes) once per consumer.
const boardDraftContextRegistry = new Map<string, BoardDraftContextEntry>()

function subscribeBoardDraftContext(
  registryKey: string,
  workspaceId: string,
  keys: ScopeKeys,
  listener: () => void
): () => void {
  let entry = boardDraftContextRegistry.get(registryKey)
  if (!entry) {
    const created: BoardDraftContextEntry = {
      context: EMPTY_CONTEXT,
      listeners: new Set(),
      refCount: 0,
      subscription: { unsubscribe() {} } as Subscription,
    }
    // Register BEFORE subscribing so `getSnapshot` observes the entry consistently;
    // the callback re-reads the live entry so a late emission after teardown no-ops.
    boardDraftContextRegistry.set(registryKey, created)
    created.subscription = liveQuery(() => loadBoardDraftContext(workspaceId, keys)).subscribe((context) => {
      const live = boardDraftContextRegistry.get(registryKey)
      if (!live) return
      live.context = context
      for (const notify of live.listeners) notify()
    })
    entry = created
  }
  entry.listeners.add(listener)
  entry.refCount += 1
  return () => {
    const current = boardDraftContextRegistry.get(registryKey)
    if (!current) return
    current.listeners.delete(listener)
    current.refCount -= 1
    if (current.refCount <= 0) {
      current.subscription.unsubscribe()
      boardDraftContextRegistry.delete(registryKey)
    }
  }
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
  const registryKey = `${workspaceId} ${keys.conversationIdKey} ${keys.branchConversationIdKey} ${keys.subtopicMessageIdKey}`
  const subscribe = useCallback(
    (onChange: () => void) => subscribeBoardDraftContext(registryKey, workspaceId, keys, onChange),
    [registryKey, workspaceId, keys]
  )
  const getSnapshot = useCallback(
    () => boardDraftContextRegistry.get(registryKey)?.context ?? EMPTY_CONTEXT,
    [registryKey]
  )
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** Tear down every shared board-draft-context subscription — for tests, so a
 *  module-level registry can't leak a liveQuery (or a snapshot) across cases. */
export function __clearBoardDraftContextRegistry(): void {
  for (const entry of boardDraftContextRegistry.values()) entry.subscription.unsubscribe()
  boardDraftContextRegistry.clear()
}
