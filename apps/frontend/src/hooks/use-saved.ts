import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useSavedService } from "@/contexts"
import { db, type CachedSavedMessage } from "@/db"
import type {
  SavedMessageView,
  SavedMessageListResponse,
  SavedStatus,
  SaveMessageInput,
  UpdateSavedMessageInput,
} from "@threa/types"

export const savedKeys = {
  all: ["saved"] as const,
  list: (workspaceId: string, status: SavedStatus) => ["saved", workspaceId, status] as const,
  byMessageId: (workspaceId: string, messageId: string) => ["saved", workspaceId, "by-message", messageId] as const,
}

function toCached(view: SavedMessageView): CachedSavedMessage {
  return {
    id: view.id,
    workspaceId: view.workspaceId,
    userId: view.userId,
    messageId: view.messageId,
    streamId: view.streamId,
    status: view.status,
    remindAt: view.remindAt,
    reminderSentAt: view.reminderSentAt,
    savedAt: view.savedAt,
    statusChangedAt: view.statusChangedAt,
    message: view.message,
    unavailableReason: view.unavailableReason,
    _savedAtMs: Date.parse(view.savedAt),
    _statusChangedAtMs: Date.parse(view.statusChangedAt),
    // 0 sentinel for "no reminder fired" so the index has a canonical
    // value instead of null/undefined (Dexie skips undefined in ranges).
    _reminderFiredAtMs: view.reminderSentAt ? Date.parse(view.reminderSentAt) : 0,
    _cachedAt: Date.now(),
  }
}

function fromCached(row: CachedSavedMessage): SavedMessageView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    messageId: row.messageId,
    streamId: row.streamId,
    status: row.status as SavedStatus,
    remindAt: row.remindAt,
    reminderSentAt: row.reminderSentAt,
    savedAt: row.savedAt,
    statusChangedAt: row.statusChangedAt,
    // IDB stores contentJson as unknown to avoid re-serialising; the server
    // is the authority, so the double cast is safe in practice.
    message: row.message as unknown as SavedMessageView["message"],
    unavailableReason: row.unavailableReason,
  }
}

/**
 * Write-through sync: after any list fetch or socket event, mirror the
 * authoritative rows into IDB so the next render — online or offline — reads
 * from the live Dexie query instead of the TanStack cache.
 */
export async function persistSavedRows(_workspaceId: string, rows: SavedMessageView[]): Promise<void> {
  if (rows.length === 0) return
  await db.savedMessages.bulkPut(rows.map(toCached))
}

export async function removeSavedRow(savedId: string): Promise<void> {
  await db.savedMessages.delete(savedId)
}

/**
 * Reconcile the cached set for a (workspace, status) page with the server's
 * authoritative page: rows that are in IDB for this (workspace, status) but
 * missing from the response — and weren't written locally after the fetch
 * started — are deleted. Mirrors the stream-sync pattern (workspace-sync.ts)
 * so entries that were removed while we were offline (or that drifted between
 * staging deploys) don't linger in the Saved view forever.
 *
 * `fetchStartedAt` is the Date.now() taken immediately before the network
 * call. Rows with `_cachedAt >= fetchStartedAt` are assumed to be from
 * concurrent socket writes and left intact.
 *
 * `hasMore` signals the server has more pages beyond this response. When
 * true we skip deletion entirely — otherwise we'd wipe locally-cached
 * page 2+ rows that were never in the server's response window.
 */
export async function replaceSavedPage(
  workspaceId: string,
  status: SavedStatus,
  rows: SavedMessageView[],
  fetchStartedAt: number,
  hasMore: boolean
): Promise<void> {
  const indexKey = status === "saved" ? "[workspaceId+status+_savedAtMs]" : "[workspaceId+status+_statusChangedAtMs]"

  const toDelete: string[] = hasMore
    ? []
    : await (async () => {
        const existing = await db.savedMessages
          .where(indexKey)
          .between([workspaceId, status, -Infinity], [workspaceId, status, Infinity], true, true)
          .toArray()
        const serverIds = new Set(rows.map((row) => row.id))
        return existing.filter((row) => !serverIds.has(row.id) && row._cachedAt < fetchStartedAt).map((row) => row.id)
      })()

  await db.transaction("rw", db.savedMessages, async () => {
    if (toDelete.length > 0) await db.savedMessages.bulkDelete(toDelete)
    if (rows.length > 0) await db.savedMessages.bulkPut(rows.map(toCached))
  })
}

/**
 * Live saved list backed by IDB, with server sync via TanStack Query. The
 * Dexie query is the render source so the Saved view works offline; the
 * server fetch runs in the background and rehydrates IDB when data arrives.
 *
 * Saved tab sorts by savedAt DESC; Done and Archived tabs sort by
 * statusChangedAt DESC.
 */
export function useSavedList(workspaceId: string, status: SavedStatus) {
  const savedService = useSavedService()

  const serverQuery = useQuery({
    queryKey: savedKeys.list(workspaceId, status),
    queryFn: async () => {
      // Capture before the await so concurrent socket writes land after
      // fetchStartedAt and survive reconciliation.
      const fetchStartedAt = Date.now()
      const res = await savedService.list(workspaceId, { status, limit: 50 })
      // `hasMore` gates reconciliation-delete: only prune when the server
      // response is the complete set for this tab (nextCursor === null).
      await replaceSavedPage(workspaceId, status, res.saved, fetchStartedAt, res.nextCursor !== null)
      return res
    },
    // INV-53: socket reconnects close their own event gap by invalidating
    // `savedKeys.all` at the top of `registerWorkspaceSocketHandlers` (in
    // active sync-v2 mode the catch-up cursor replays the missed events
    // instead); `refetchOnReconnect: true` then catches the pure browser
    // online/offline case. `refetchOnMount: true` plus `staleTime: Infinity`
    // makes the invalidation land on the next render.
    staleTime: Infinity,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    enabled: !!workspaceId,
  })

  const rows = useLiveQuery(async () => {
    if (!workspaceId) return [] as CachedSavedMessage[]
    const indexKey = status === "saved" ? "[workspaceId+status+_savedAtMs]" : "[workspaceId+status+_statusChangedAtMs]"
    return db.savedMessages
      .where(indexKey)
      .between([workspaceId, status, -Infinity], [workspaceId, status, Infinity], true, true)
      .reverse()
      .toArray()
  }, [workspaceId, status])

  const items = useMemo(() => (rows ?? []).map(fromCached), [rows])

  return {
    items,
    isLoading: serverQuery.isLoading && (rows?.length ?? 0) === 0,
    isFetching: serverQuery.isFetching,
    error: serverQuery.error,
    nextCursor: serverQuery.data?.nextCursor ?? null,
    refetch: serverQuery.refetch,
  }
}

/**
 * Cache-only observer for "is this message saved?" — reads from the IDB
 * messageId index so hover buttons and context menus don't trigger extra
 * fetches.
 */
export function useSavedForMessage(workspaceId: string, messageId: string | null) {
  return useLiveQuery(async () => {
    if (!workspaceId || !messageId) return null
    const row = await db.savedMessages
      .where("messageId")
      .equals(messageId)
      .and((r) => r.workspaceId === workspaceId)
      .first()
    return row ? fromCached(row) : null
  }, [workspaceId, messageId])
}

export function useSaveMessage(workspaceId: string) {
  const savedService = useSavedService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: SaveMessageInput) => savedService.create(workspaceId, input),
    onSuccess: (saved) => {
      void persistSavedRows(workspaceId, [saved])
      queryClient.invalidateQueries({ queryKey: savedKeys.list(workspaceId, "saved") })
      queryClient.invalidateQueries({ queryKey: savedKeys.list(workspaceId, "done") })
      queryClient.invalidateQueries({ queryKey: savedKeys.list(workspaceId, "archived") })
    },
  })
}

export function useUpdateSaved(workspaceId: string) {
  const savedService = useSavedService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ savedId, input }: { savedId: string; input: UpdateSavedMessageInput }) =>
      savedService.update(workspaceId, savedId, input),
    onSuccess: (saved) => {
      void persistSavedRows(workspaceId, [saved])
      queryClient.invalidateQueries({ queryKey: savedKeys.list(workspaceId, "saved") })
      queryClient.invalidateQueries({ queryKey: savedKeys.list(workspaceId, "done") })
      queryClient.invalidateQueries({ queryKey: savedKeys.list(workspaceId, "archived") })
    },
  })
}

export function useDeleteSaved(workspaceId: string) {
  const savedService = useSavedService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (savedId: string) => savedService.delete(workspaceId, savedId),
    onSuccess: (_res, savedId) => {
      void removeSavedRow(savedId)
      queryClient.invalidateQueries({ queryKey: savedKeys.list(workspaceId, "saved") })
      queryClient.invalidateQueries({ queryKey: savedKeys.list(workspaceId, "done") })
      queryClient.invalidateQueries({ queryKey: savedKeys.list(workspaceId, "archived") })
    },
  })
}

export type { SavedMessageListResponse }

/**
 * Live count of saved items with a fired-but-unacknowledged reminder. Used by
 * the sidebar badge — having saved things isn't itself noisy, but a fired
 * reminder is the signal worth surfacing. Range-query on the
 * `[workspaceId+status+_reminderFiredAtMs]` compound index, between 1 and
 * +Infinity, so Dexie counts the fired rows without materialising objects.
 */
export function useLiveSavedCount(workspaceId: string): number {
  const count = useLiveQuery(async () => {
    if (!workspaceId) return 0
    return db.savedMessages
      .where("[workspaceId+status+_reminderFiredAtMs]")
      .between([workspaceId, "saved", 1], [workspaceId, "saved", Infinity], true, true)
      .count()
  }, [workspaceId])
  return count ?? 0
}
