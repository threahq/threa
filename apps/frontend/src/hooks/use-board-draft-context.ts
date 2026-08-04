import { useLiveQuery } from "dexie-react-hooks"
import { useMemo } from "react"
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

/** Stable signature over a set of draft scopes — the gate every query below keys on. */
export function draftScopesSignature(scopes: Iterable<string>): string {
  return [...new Set(scopes)].sort().join("|")
}

/**
 * The cached conversations a set of `board:*` draft scopes references, resolved
 * once for every consumer (the drafts explorer's location labels, the composer
 * pile's landing sites) so the two can't drift (INV-35). Every query is keyed on
 * an id signature derived from `scopesSignature`, never on the drafts array, so a
 * keystroke's draft write doesn't re-fire it — the property an always-mounted
 * composer depends on.
 */
export function useBoardDraftContext(workspaceId: string, scopesSignature: string): BoardDraftContext {
  const boardConversationIdKey = useMemo(() => {
    const ids = new Set<string>()
    for (const scope of scopesSignature.split("|")) {
      const parsed = parseBoardDraftKey(scope)
      if (parsed && parsed.kind !== "subtopic") ids.add(parsed.conversationId)
    }
    return [...ids].sort().join(",")
  }, [scopesSignature])

  const boardBranchConversationIdKey = useMemo(() => {
    const ids = new Set<string>()
    for (const scope of scopesSignature.split("|")) {
      const parsed = parseBoardDraftKey(scope)
      if (parsed?.kind === "branch-reply") ids.add(parsed.conversationId)
    }
    return [...ids].sort().join(",")
  }, [scopesSignature])

  // Sub-topic drafts name only their fork message; branch drafts name a child
  // conversation whose parent must be derived structurally (its anchor thread's
  // parent message → the conversation holding it — sub-topic conversations
  // carry no `parentConversationId`). Both resolve to the HOSTING conversation
  // the explorer deep-links to, since that surface hosts the draft's composer.
  const subtopicMessageIdKey = useMemo(() => {
    const ids = new Set<string>()
    for (const scope of scopesSignature.split("|")) {
      const parsed = parseBoardDraftKey(scope)
      if (parsed?.kind === "subtopic") ids.add(parsed.messageId)
    }
    return [...ids].sort().join(",")
  }, [scopesSignature])

  const emptyBoardContext = useMemo(
    () => ({
      posts: [] as CachedBoardPost[],
      hostPostByMessageId: new Map<string, CachedBoardPost>(),
      parentPostByBranchConversationId: new Map<string, CachedBoardPost>(),
    }),
    []
  )

  const boardDraftContext = useLiveQuery(
    async () => {
      if (!boardConversationIdKey && !subtopicMessageIdKey) return emptyBoardContext
      const convIds = boardConversationIdKey ? boardConversationIdKey.split(",") : []
      const branchIds = new Set(boardBranchConversationIdKey ? boardBranchConversationIdKey.split(",") : [])
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
      return { posts: [...referenced, ...hostRows], hostPostByMessageId, parentPostByBranchConversationId }
    },
    [boardConversationIdKey, boardBranchConversationIdKey, subtopicMessageIdKey, workspaceId, emptyBoardContext],
    emptyBoardContext
  )

  const posts = boardDraftContext.posts

  const boardPostMap = useMemo(() => {
    const map = new Map<string, CachedBoardPost>()
    for (const post of posts ?? []) map.set(post.id, post)
    return map
  }, [posts])

  const { hostPostByMessageId, parentPostByBranchConversationId } = boardDraftContext

  return useMemo(
    () => ({ boardPostMap, hostPostByMessageId, parentPostByBranchConversationId }),
    [boardPostMap, hostPostByMessageId, parentPostByBranchConversationId]
  )
}
