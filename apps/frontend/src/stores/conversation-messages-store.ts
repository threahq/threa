import { useEffect, useMemo, useState } from "react"
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

// INV-9 exception, the workspace-store idiom: one module-level snapshot of the
// backfilled rows the board's first frame needs, read ONCE in bulk before the
// reveal. A card whose rail doesn't cover membership renders its older leads from
// this table, but its liveQuery is enabled only after `rail.resolved` and Dexie's
// first emission is always a tick after that — so those rows could never be in
// the revealed frame, and the card painted its projection window ("4 earlier")
// with the leads popping in after. The snapshot makes the value available
// synchronously at mount; the liveQuery owns it from its first emission on.
const snapshotByConversation = new Map<string, CachedConversationMessage[]>()

/**
 * Fill the snapshot for `conversationIds` from one bulk Dexie read. Only ABSENT
 * keys are written: a key already present came from a liveQuery emission (or an
 * earlier prime that a live emission has since refreshed) and is newer than
 * anything this read can produce. A conversation with no backfilled rows is
 * primed to an empty array — "primed" must mean "read", not "found something",
 * or the gate would wait forever on a card that legitimately has none.
 *
 * Bounded by the caller: the board primes the prewarmed cards' conversations only.
 */
export async function primeConversationMessages(conversationIds: string[]): Promise<void> {
  const missing = conversationIds.filter((id) => !snapshotByConversation.has(id))
  if (missing.length === 0) return
  const rows = await db.conversationMessages.where("conversationId").anyOf(missing).toArray()
  const byConversation = new Map<string, CachedConversationMessage[]>(missing.map((id) => [id, []]))
  for (const row of rows) byConversation.get(row.conversationId)?.push(row)
  for (const [id, conversationRows] of byConversation) {
    // Re-check: a liveQuery may have emitted for this conversation while the read
    // was in flight, and that value wins.
    if (snapshotByConversation.has(id)) continue
    snapshotByConversation.set(id, conversationRows)
  }
}

/** Whether every one of `conversationIds` has been read into the snapshot. */
export function conversationMessagesPrimed(conversationIds: string[]): boolean {
  return conversationIds.every((id) => snapshotByConversation.has(id))
}

/** Drop the snapshot — for tests, so a module-level map can't leak rows across
 *  cases, and for a workspace switch (a different board, different ids). */
export function __resetConversationMessageSnapshots(): void {
  snapshotByConversation.clear()
}

/**
 * A conversation's backfilled messages, live from IDB. Gated: `enabled: false`
 * touches no table, so it registers no Dexie subscription and never re-fires on
 * a write — a board full of collapsed cards pays nothing (the #1640 cost class).
 *
 * Before the liveQuery's first emission the primed snapshot is the value, so a
 * card enabled at reveal renders its older leads in that same frame rather than
 * a tick later. Once the liveQuery emits it owns the value and refreshes the
 * snapshot, keeping later mounts warm.
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
  useEffect(() => {
    if (!enabled || !rows) return
    snapshotByConversation.set(conversationId, rows)
  }, [conversationId, enabled, rows])
  if (!enabled) return EMPTY
  return rows ?? snapshotByConversation.get(conversationId) ?? EMPTY
}

/**
 * The board's reveal-gate input for the backfill store: resolves once the
 * prewarmed cards' conversations have been read into the snapshot, so the cards
 * that render older leads have them in their first frame.
 *
 * Derived from the snapshot rather than latched: a workspace switch brings a
 * whole new id set, which must gate afresh. Un-revealing on a LATER id set (a
 * scroll, an added conversation) is `useBoardRevealLatch`'s job, not this gate's.
 */
export function useBoardBackfillPrimed(conversationIds: string[]): boolean {
  const key = conversationIds.join(",")
  const ids = useMemo(() => (key ? key.split(",") : []), [key])
  // The prime resolving mutates a module map, which no render observes on its
  // own — this is the re-read signal.
  const [, bumpPrimeGeneration] = useState(0)
  useEffect(() => {
    if (ids.length === 0) return
    let cancelled = false
    void primeConversationMessages(ids).then(() => {
      if (!cancelled) bumpPrimeGeneration((generation) => generation + 1)
    })
    return () => {
      cancelled = true
    }
  }, [ids])
  return conversationMessagesPrimed(ids)
}
