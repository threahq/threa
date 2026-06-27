import Dexie from "dexie"
import { useLiveQuery } from "dexie-react-hooks"
import { db, type CachedBoardPost } from "@/db"
import type { BoardPost, BoardPostMessage, ConversationWithStaleness } from "@threa/types"

/**
 * How many trailing replies a board card previews. Mirrors the backend's
 * `listByWorkspace` projection (service.ts), so an optimistic append caps the
 * same way a refetch would.
 */
const RECENT_PREVIEW_CAP = 3

function lastActivityMs(conversation: { lastActivityAt: string }): number {
  const ms = Date.parse(conversation.lastActivityAt)
  return Number.isNaN(ms) ? 0 : ms
}

function toCached(workspaceId: string, post: BoardPost, status?: "pending"): CachedBoardPost {
  return {
    ...post,
    id: post.conversation.id,
    workspaceId,
    _lastActivityMs: lastActivityMs(post.conversation),
    _cachedAt: Date.now(),
    _status: status,
  }
}

/**
 * Reactive board feed for a workspace, newest activity first — the board's read
 * authority, mirroring how the timeline reads `events` from IDB. A live
 * `conversation:*` merge or an optimistic write re-sorts the feed in place
 * without a refetch. Returns `undefined` until the first IDB read resolves
 * (loading), `[]` when the store is genuinely empty.
 */
export function useBoardPosts(workspaceId: string): CachedBoardPost[] | undefined {
  return useLiveQuery(
    () =>
      db.conversations
        .where("[workspaceId+_lastActivityMs]")
        .between([workspaceId, Dexie.minKey], [workspaceId, Dexie.maxKey])
        .reverse()
        .toArray(),
    [workspaceId]
  )
}

/**
 * Seed the board store from a bootstrap/page fetch (subscribe-then-fetch,
 * INV-53). `bulkPut` upserts the fetched cards without touching rows the page
 * didn't return, so optimistic-pending rows not yet visible to the server
 * survive, and a card the server now returns is reconciled (its `_status`
 * cleared) over any optimistic copy.
 */
export async function seedBoardPosts(workspaceId: string, posts: BoardPost[]): Promise<void> {
  if (posts.length === 0) return
  await db.conversations.bulkPut(posts.map((post) => toCached(workspaceId, post)))
}

/**
 * Apply a conversation aggregate from a `conversation:*` event onto the board's
 * IDB row: merge the new aggregate (re-sorting on `lastActivityAt`) while
 * keeping the cached preview messages — the event carries the aggregate, not the
 * message bodies. Returns `false` when no row exists yet, so the caller can
 * hydrate a card it cannot render from the event alone.
 */
export async function mergeBoardConversation(
  conversationId: string,
  conversation: ConversationWithStaleness
): Promise<boolean> {
  // Read-modify-write in one rw transaction so a concurrent optimistic write or
  // a second echo can't merge over a stale read of this row.
  return db.transaction("rw", db.conversations, async () => {
    const existing = await db.conversations.get(conversationId)
    if (!existing) return false
    await db.conversations.put({
      ...existing,
      conversation,
      _lastActivityMs: lastActivityMs(conversation),
      _cachedAt: Date.now(),
      _status: undefined,
    })
    return true
  })
}

/**
 * Optimistically reflect the viewer's own reply into a visible card: append the
 * message to the preview, bump activity to `atMs` (so the card jumps to the top
 * like a real bump would), and mark the row pending until the authoritative
 * `conversation:updated` echo merges over it. No-op when the card isn't cached
 * (a reply into a not-yet-seen conversation surfaces via the event path).
 */
export async function optimisticBoardReply(
  conversationId: string,
  message: BoardPostMessage,
  atMs: number
): Promise<void> {
  // Read-modify-write in one rw transaction so it can't race the authoritative
  // echo's merge through a stale read. Dedup by id so a retry can't double-append.
  await db.transaction("rw", db.conversations, async () => {
    const existing = await db.conversations.get(conversationId)
    if (!existing) return
    if (existing.recentMessages.some((m) => m.id === message.id)) return
    const recentMessages = [...existing.recentMessages, message].slice(-RECENT_PREVIEW_CAP)
    await db.conversations.put({
      ...existing,
      conversation: { ...existing.conversation, lastActivityAt: new Date(atMs).toISOString() },
      recentMessages,
      totalReplies: existing.totalReplies + 1,
      _lastActivityMs: atMs,
      _cachedAt: Date.now(),
      _status: "pending",
    })
  })
}
