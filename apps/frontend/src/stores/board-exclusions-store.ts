import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { db } from "@/db"

/**
 * The viewer's per-stream board mutes and per-conversation hides (board-view-design.md
 * § "Hide & mute"), read reactively from IDB so the board re-filters the instant a
 * hide/mute lands — locally (optimistic) or from another device (socket). Mirrors
 * `board-store`'s IDB-observer pattern.
 */

/** Hidden conversations for a workspace as `conversationId → hiddenAt` (ms watermark).
 *  Memoized on the live rows so the returned Map keeps a stable identity between
 *  data changes — callers use it in `useMemo`/`useCallback` deps. */
export function useBoardHiddenConversations(workspaceId: string): Map<string, number> {
  const rows = useLiveQuery(
    () => db.boardHiddenConversations.where("workspaceId").equals(workspaceId).toArray(),
    [workspaceId]
  )
  return useMemo(() => new Map((rows ?? []).map((row) => [row.id, row.hiddenAt])), [rows])
}

/** Muted root-stream ids for a workspace (stable identity between data changes). */
export function useBoardMutedStreamIds(workspaceId: string): Set<string> {
  const rows = useLiveQuery(
    () => db.boardMutedStreams.where("workspaceId").equals(workspaceId).toArray(),
    [workspaceId]
  )
  return useMemo(() => new Set((rows ?? []).map((row) => row.id)), [rows])
}

export interface BoardExclusionsSeed {
  hiddenConversations: { conversationId: string; hiddenAt: string }[]
  mutedStreamIds: string[]
}

/**
 * Replace the workspace's exclusion rows from a bootstrap fetch (subscribe-then-fetch,
 * INV-53). Authoritative: rows the server no longer returns are dropped (a hide/mute
 * removed on another device before this fetch), unlike the board feed's additive seed.
 */
export async function seedBoardExclusions(workspaceId: string, seed: BoardExclusionsSeed): Promise<void> {
  const cachedAt = Date.now()
  await db.transaction("rw", db.boardHiddenConversations, db.boardMutedStreams, async () => {
    const [staleHidden, staleMuted] = await Promise.all([
      db.boardHiddenConversations.where("workspaceId").equals(workspaceId).primaryKeys(),
      db.boardMutedStreams.where("workspaceId").equals(workspaceId).primaryKeys(),
    ])
    await Promise.all([
      db.boardHiddenConversations.bulkDelete(staleHidden),
      db.boardMutedStreams.bulkDelete(staleMuted),
    ])
    await db.boardHiddenConversations.bulkPut(
      seed.hiddenConversations.map((row) => ({
        id: row.conversationId,
        workspaceId,
        hiddenAt: Date.parse(row.hiddenAt),
        _cachedAt: cachedAt,
      }))
    )
    await db.boardMutedStreams.bulkPut(
      seed.mutedStreamIds.map((streamId) => ({ id: streamId, workspaceId, _cachedAt: cachedAt }))
    )
  })
}

export async function putHidden(workspaceId: string, conversationId: string, hiddenAt: number): Promise<void> {
  await db.boardHiddenConversations.put({ id: conversationId, workspaceId, hiddenAt, _cachedAt: Date.now() })
}

export async function deleteHidden(conversationId: string): Promise<void> {
  await db.boardHiddenConversations.delete(conversationId)
}

export async function putMuted(workspaceId: string, streamId: string): Promise<void> {
  await db.boardMutedStreams.put({ id: streamId, workspaceId, _cachedAt: Date.now() })
}

export async function deleteMuted(streamId: string): Promise<void> {
  await db.boardMutedStreams.delete(streamId)
}
