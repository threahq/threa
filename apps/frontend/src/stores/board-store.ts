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
 * IDB row: merge the new aggregate (re-sorting on `lastActivityAt`) and, when the
 * event carries the message that triggered it, append that body to the preview so
 * a new reply shows in place — not just the activity bump. `totalReplies` is
 * recomputed from the aggregate's authoritative `messageIds`, so the "N more" gap
 * tracks a foreign reply or a reassignment without waiting for a reseed. Returns
 * `false` when no row exists yet, so the caller can hydrate a card it cannot
 * render from the event alone.
 */
export async function mergeBoardConversation(
  conversationId: string,
  conversation: ConversationWithStaleness,
  triggeringMessage?: BoardPostMessage
): Promise<boolean> {
  // Read-modify-write in one rw transaction so a concurrent optimistic write or
  // a second echo can't merge over a stale read of this row.
  return db.transaction("rw", db.conversations, async () => {
    const existing = await db.conversations.get(conversationId)
    if (!existing) return false

    // `messageIds` is primary, opening-first; the opening renders separately, so
    // the replies are the rest. A thread's opening is the parent message (not a
    // member), so nothing is sliced there. Mirrors the server's board projection.
    const openingId = existing.openingMessage?.id
    const messageIds = conversation.messageIds ?? []
    const replyIds = openingId === messageIds[0] ? messageIds.slice(1) : messageIds

    // Append the triggering body only when it's actually a primary reply here;
    // dedup by id (an optimistic write or a re-echo already has it), order by
    // time, keep the trailing window.
    let recentMessages = existing.recentMessages
    if (triggeringMessage && replyIds.includes(triggeringMessage.id)) {
      recentMessages = [...existing.recentMessages.filter((m) => m.id !== triggeringMessage.id), triggeringMessage]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-RECENT_PREVIEW_CAP)
    }

    await db.conversations.put({
      ...existing,
      conversation,
      recentMessages,
      totalReplies: replyIds.length,
      _lastActivityMs: lastActivityMs(conversation),
      _cachedAt: Date.now(),
      _status: undefined,
    })
    return true
  })
}

/**
 * Optimistically reflect the viewer's own reply into a visible card: append the
 * message to the preview, bump activity to `atMs`, and mark the row pending until
 * the authoritative `conversation:updated` echo merges over it. No-op when the
 * card isn't cached (a reply into a not-yet-seen conversation surfaces via the
 * event path).
 *
 * The `_lastActivityMs` bump is IDB truth (it re-sorts the live feed and a fresh
 * snapshot lands the card at the top), but the stable view holds a committed
 * card's position frozen, so the reply shows in place — it does not yank the card
 * to the top under the reader (`use-stable-board-view`, INV-61).
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
