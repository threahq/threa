import { useLiveQuery } from "dexie-react-hooks"
import { db, type CachedConversationMessage } from "@/db"
import type { BoardPostMessage } from "@threa/types"

const EMPTY: CachedConversationMessage[] = []

function toCached(workspaceId: string, conversationId: string, message: BoardPostMessage): CachedConversationMessage {
  return {
    ...message,
    messageId: message.id,
    conversationId,
    workspaceId,
    _cachedAt: Date.now(),
  }
}

/**
 * Land a conversation's server backfill (`GET /conversations/:id/board-messages`)
 * in IDB so the expanded card and the panel render it from the store instead of
 * from the response body — live-patched afterwards, unlike a response.
 *
 * Replace-per-conversation in one transaction: the fetch is the authoritative
 * membership list, so a message re-filed out of this conversation drops with the
 * write rather than lingering as a row nothing would ever remove.
 */
export async function seedConversationMessages(
  workspaceId: string,
  conversationId: string,
  messages: BoardPostMessage[]
): Promise<void> {
  await db.transaction("rw", db.conversationMessages, async () => {
    await db.conversationMessages.where("conversationId").equals(conversationId).delete()
    await db.conversationMessages.bulkPut(messages.map((message) => toCached(workspaceId, conversationId, message)))
  })
}

/**
 * Prune a conversation's backfilled rows to the membership a `conversation:updated`
 * event just named. The event is fresher than any fetch that seeded these rows, so
 * a message re-filed OUT drops here — without this the merged view's rail∪store
 * union would keep resurrecting it after the board snapshot pruned it.
 */
export async function pruneConversationMessagesToMembership(
  conversationId: string,
  memberIds: ReadonlySet<string>
): Promise<void> {
  await db.transaction("rw", db.conversationMessages, async () => {
    const rows = await db.conversationMessages.where("conversationId").equals(conversationId).toArray()
    const stale = rows.filter((row) => !memberIds.has(row.messageId)).map((row) => row.messageId)
    if (stale.length === 0) return
    await db.conversationMessages.bulkDelete(stale)
  })
}

/** Drop every backfilled row of a conversation — an emptied conversation is no
 *  longer a card, so its cached bodies must go with it. */
export async function deleteConversationMessages(conversationId: string): Promise<void> {
  await db.conversationMessages.where("conversationId").equals(conversationId).delete()
}

type ConversationMessagePatch = Partial<Omit<CachedConversationMessage, "messageId" | "conversationId" | "workspaceId">>

/**
 * Apply a live message patch (edit, delete, reaction, link preview) onto a
 * backfilled row. No-op when the row isn't cached — the sync handlers call this
 * for every stream message, and only a conversation the viewer has expanded has
 * rows here.
 */
export async function patchConversationMessage(
  messageId: string,
  patch: ConversationMessagePatch | ((row: CachedConversationMessage) => ConversationMessagePatch)
): Promise<void> {
  await db.transaction("rw", db.conversationMessages, async () => {
    const existing = await db.conversationMessages.get(messageId)
    if (!existing) return
    const fields = typeof patch === "function" ? patch(existing) : patch
    // A patch that changes nothing (a duplicate reaction, a re-delivered edit)
    // must not write: the `_cachedAt` bump alone wakes every liveQuery watching
    // this conversation.
    const changed = Object.entries(fields).some(
      ([key, value]) => !Object.is(existing[key as keyof CachedConversationMessage], value)
    )
    if (!changed) return
    await db.conversationMessages.put({ ...existing, ...fields, _cachedAt: Date.now() })
  })
}

/**
 * A conversation's backfilled messages, live from IDB. Gated: `enabled: false`
 * touches no table, so it registers no Dexie subscription and never re-fires on
 * a write — a board full of collapsed cards pays nothing (the #1640 cost class).
 */
export function useConversationBackfillMessages(
  conversationId: string,
  opts: { enabled: boolean }
): CachedConversationMessage[] {
  const enabled = opts.enabled
  const rows = useLiveQuery(
    () => (enabled ? db.conversationMessages.where("conversationId").equals(conversationId).toArray() : EMPTY),
    [conversationId, enabled]
  )
  return rows ?? EMPTY
}
