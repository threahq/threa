import Dexie from "dexie"
import { useLiveQuery } from "dexie-react-hooks"
import { db, type CachedBoardPost } from "@/db"
import type { BoardPost, ConversationWithStaleness } from "@threa/types"

/**
 * How many trailing replies a board card previews. Mirrors the backend's
 * `listByWorkspace` projection (service.ts), so an optimistic append caps the
 * same way a refetch would. The single source for this cap — the board card's
 * collapsed slice imports it too.
 */
export const RECENT_PREVIEW_CAP = 3

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
 * Record a stream a conversation now reaches, from a `conversation:message_assigned`
 * event, onto its board row's `streamIds`. A conversation can span its root + the
 * root's threads (one root — board-view-design.md); the card subscribes to each
 * stream's rail, and a convert-to-thread / cross-stream reply lands in a stream
 * the snapshot didn't list yet. Adding it here lets the card draw that member live
 * without a board refetch. No-op when the card isn't cached or already lists the
 * stream; never creates a row (a card we don't have can't be rendered from this
 * event alone).
 */
export async function addBoardConversationStream(conversationId: string, streamId: string): Promise<void> {
  await db.transaction("rw", db.conversations, async () => {
    const existing = await db.conversations.get(conversationId)
    if (!existing) return
    const streamIds = existing.streamIds ?? []
    if (streamIds.includes(streamId)) return
    await db.conversations.put({ ...existing, streamIds: [...streamIds, streamId] })
  })
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
    // An emptied conversation is no longer a board card — it mirrors the server's
    // `cardinality(message_ids) > 0` board filter, so a conversation whose last
    // message was reassigned or threaded off (the source of a `threadFromMessage`
    // reply) drops here rather than lingering as a stale card. Report it handled
    // even with no row so the caller doesn't hydrate a card that shouldn't exist.
    // Guard on an EXPLICIT empty array: a payload that omits `messageIds` (a
    // partial/aggregate-only event) is not "known empty" — fall through to upsert.
    if (Array.isArray(conversation.messageIds) && conversation.messageIds.length === 0) {
      await db.conversations.delete(conversationId)
      return true
    }
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
