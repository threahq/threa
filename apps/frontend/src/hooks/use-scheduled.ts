import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { serializeToMarkdown } from "@threa/prosemirror"
import { useScheduledService } from "@/contexts"
import { useSyncEngine } from "@/sync/sync-engine"
import { useUser } from "@/auth"
import { useWorkspaceUsers } from "@/stores/workspace-store"
import { db, type CachedScheduledMessage } from "@/db"
import { enqueueOperation } from "@/sync/operation-queue"
import type {
  ScheduledMessageView,
  ScheduledMessageStatus,
  ScheduleMessageInput,
  UpdateScheduledMessageInput,
  JSONContent,
} from "@threa/types"

export const scheduledKeys = {
  all: ["scheduled"] as const,
  list: (workspaceId: string, status: ScheduledMessageStatus, streamId?: string) =>
    streamId
      ? (["scheduled", workspaceId, status, "stream", streamId] as const)
      : (["scheduled", workspaceId, status] as const),
}

const LOCAL_ID_PREFIX = "sched_local_"

function generateLocalScheduledId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 10)
  return `${LOCAL_ID_PREFIX}${timestamp}${random}`
}

function generateClientMessageId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 10)
  return `cli_sched_${timestamp}${random}`
}

/** True for rows written optimistically that haven't yet been confirmed by the server. */
export function isLocalScheduledId(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX)
}

function toCached(view: ScheduledMessageView, opts?: { localOnly?: boolean }): CachedScheduledMessage {
  return {
    id: view.id,
    workspaceId: view.workspaceId,
    userId: view.userId,
    streamId: view.streamId,
    parentMessageId: view.parentMessageId,
    contentJson: view.contentJson,
    contentMarkdown: view.contentMarkdown,
    attachmentIds: view.attachmentIds,
    metadata: view.metadata,
    scheduledFor: view.scheduledFor,
    status: view.status,
    sentMessageId: view.sentMessageId,
    lastError: view.lastError,
    editActiveUntil: view.editActiveUntil,
    clientMessageId: view.clientMessageId,
    version: view.version,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    statusChangedAt: view.statusChangedAt,
    _localOnly: opts?.localOnly ? true : undefined,
    _scheduledForMs: Date.parse(view.scheduledFor),
    _statusChangedAtMs: Date.parse(view.statusChangedAt),
    _cachedAt: Date.now(),
  }
}

function fromCached(row: CachedScheduledMessage): ScheduledMessageView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    streamId: row.streamId,
    parentMessageId: row.parentMessageId,
    // IDB stores contentJson as unknown to avoid re-serialising; the server
    // is the authority, so the cast is safe in practice.
    contentJson: row.contentJson as JSONContent,
    contentMarkdown: row.contentMarkdown,
    attachmentIds: row.attachmentIds,
    metadata: row.metadata,
    scheduledFor: row.scheduledFor,
    status: row.status as ScheduledMessageStatus,
    sentMessageId: row.sentMessageId,
    lastError: row.lastError,
    editActiveUntil: row.editActiveUntil,
    clientMessageId: row.clientMessageId,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    statusChangedAt: row.statusChangedAt,
  }
}

/**
 * Write-through sync: after any list fetch or socket event, mirror the
 * authoritative rows into IDB so the next render — online or offline — reads
 * from the live Dexie query.
 */
export async function persistScheduledRows(rows: ScheduledMessageView[]): Promise<void> {
  if (rows.length === 0) return
  await db.scheduledMessages.bulkPut(rows.map((row) => toCached(row)))
}

export async function removeScheduledRow(id: string): Promise<void> {
  await db.scheduledMessages.delete(id)
}

/**
 * Replace a local placeholder row with the server-issued row after the
 * `schedule_message` op completes. Done in one transaction so the live Dexie
 * query never observes a frame with neither row present.
 */
export async function replaceLocalScheduledRow(
  placeholderId: string,
  authoritative: ScheduledMessageView
): Promise<void> {
  await db.transaction("rw", db.scheduledMessages, async () => {
    await db.scheduledMessages.delete(placeholderId)
    await db.scheduledMessages.put(toCached(authoritative))
  })
}

/**
 * Reconcile a (workspace, status[, streamId]) page with the server's
 * authoritative response. Same shape as `replaceSavedPage` — rows in IDB
 * for this slice that are missing from the response and were cached before
 * `fetchStartedAt` get pruned. `hasMore` skips reconciliation entirely so
 * page-2+ rows aren't wiped. Local-only rows survive reconciliation since
 * the server doesn't know about them yet.
 */
export async function replaceScheduledPage(
  workspaceId: string,
  status: ScheduledMessageStatus,
  rows: ScheduledMessageView[],
  fetchStartedAt: number,
  hasMore: boolean,
  streamId?: string
): Promise<void> {
  const pendingIndexKey = streamId
    ? "[workspaceId+streamId+status+_scheduledForMs]"
    : "[workspaceId+status+_scheduledForMs]"
  const indexKey = status === "pending" ? pendingIndexKey : "[workspaceId+status+_statusChangedAtMs]"

  const toDelete: string[] = hasMore
    ? []
    : await (async () => {
        const collection = streamId
          ? db.scheduledMessages
              .where(indexKey)
              .between(
                [workspaceId, streamId, status, -Infinity],
                [workspaceId, streamId, status, Infinity],
                true,
                true
              )
          : db.scheduledMessages
              .where(indexKey)
              .between([workspaceId, status, -Infinity], [workspaceId, status, Infinity], true, true)
        const existing = await collection.toArray()
        const serverIds = new Set(rows.map((row) => row.id))
        return existing
          .filter((row) => !serverIds.has(row.id) && row._cachedAt < fetchStartedAt && !row._localOnly)
          .map((row) => row.id)
      })()

  await db.transaction("rw", db.scheduledMessages, async () => {
    if (toDelete.length > 0) await db.scheduledMessages.bulkDelete(toDelete)
    if (rows.length > 0) await db.scheduledMessages.bulkPut(rows.map((row) => toCached(row)))
  })
}

/**
 * Live scheduled-list backed by IDB, with server sync via TanStack Query.
 * Component reads from the Dexie query (offline-first) and the network refresh
 * runs in the background, rehydrating IDB on success. Pending rows order by
 * scheduled_for ASC; sent/failed/cancelled by status_changed_at DESC.
 */
export function useScheduledList(workspaceId: string, status: ScheduledMessageStatus, streamId?: string) {
  const scheduledService = useScheduledService()

  const serverQuery = useQuery({
    queryKey: scheduledKeys.list(workspaceId, status, streamId),
    queryFn: async () => {
      const fetchStartedAt = Date.now()
      const res = await scheduledService.list(workspaceId, { status, streamId, limit: 50 })
      await replaceScheduledPage(workspaceId, status, res.scheduled, fetchStartedAt, res.nextCursor !== null, streamId)
      return res
    },
    // INV-53: workspace-sync invalidates `scheduledKeys.all` on reconnect at
    // the top of `registerWorkspaceSocketHandlers`; refetchOnReconnect catches
    // the pure online/offline case; refetchOnMount + staleTime: Infinity makes
    // the invalidation actually fire on next render.
    staleTime: Infinity,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    enabled: !!workspaceId,
  })

  const rows = useLiveQuery(async () => {
    if (!workspaceId) return [] as CachedScheduledMessage[]
    if (status === "pending") {
      if (streamId) {
        return db.scheduledMessages
          .where("[workspaceId+streamId+status+_scheduledForMs]")
          .between([workspaceId, streamId, status, -Infinity], [workspaceId, streamId, status, Infinity], true, true)
          .toArray()
      }
      return db.scheduledMessages
        .where("[workspaceId+status+_scheduledForMs]")
        .between([workspaceId, status, -Infinity], [workspaceId, status, Infinity], true, true)
        .toArray()
    }
    return db.scheduledMessages
      .where("[workspaceId+status+_statusChangedAtMs]")
      .between([workspaceId, status, -Infinity], [workspaceId, status, Infinity], true, true)
      .reverse()
      .toArray()
  }, [workspaceId, status, streamId])

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
 * Live count of pending scheduled messages for a workspace — used by the
 * sidebar badge and composer popover trigger. Range query on the
 * `[workspaceId+status+_scheduledForMs]` index counts without materialising
 * objects.
 */
export function useLiveScheduledCount(workspaceId: string): number {
  const count = useLiveQuery(async () => {
    if (!workspaceId) return 0
    return db.scheduledMessages
      .where("[workspaceId+status+_scheduledForMs]")
      .between([workspaceId, "pending", -Infinity], [workspaceId, "pending", Infinity], true, true)
      .count()
  }, [workspaceId])
  return count ?? 0
}

/**
 * Schedule a new message — offline-first. Mirrors the `sendMessage` pattern:
 *  1. Synthesize an optimistic `ScheduledMessageView` with `_localOnly: true`
 *     and a `sched_local_<ulid>` placeholder id, write it to IDB so the live
 *     query renders the row immediately.
 *  2. Enqueue a `schedule_message` operation with the input + the
 *     placeholder id so the operation queue executor knows what to swap.
 *  3. Kick the operation queue and return immediately. The composer unblocks
 *     the same instant; the network round-trip happens in the background and
 *     replaces the placeholder when it lands (success) or surfaces a toast
 *     (terminal error after retry budget is exhausted).
 */
export function useScheduleMessage(workspaceId: string) {
  const queryClient = useQueryClient()
  const user = useUser()
  const workspaceUsers = useWorkspaceUsers(workspaceId)
  const syncEngine = useSyncEngine()

  return useMutation({
    mutationFn: async (input: ScheduleMessageInput) => {
      const currentUserId = workspaceUsers.find((u) => u.workosUserId === user?.id)?.id
      if (!currentUserId) {
        throw new Error("Cannot schedule message: user identity not resolved yet")
      }
      const placeholderId = generateLocalScheduledId()
      const clientMessageId = input.clientMessageId ?? generateClientMessageId()
      const nowIso = new Date().toISOString()

      const optimistic: ScheduledMessageView = {
        id: placeholderId,
        workspaceId,
        userId: currentUserId,
        streamId: input.streamId,
        parentMessageId: input.parentMessageId ?? null,
        contentJson: input.contentJson,
        // The server derives the canonical markdown from contentJson; this local
        // projection only feeds the optimistic preview until the server view
        // replaces it.
        contentMarkdown: serializeToMarkdown(input.contentJson),
        attachmentIds: input.attachmentIds ?? [],
        metadata: input.metadata ?? null,
        scheduledFor: input.scheduledFor,
        status: "pending",
        sentMessageId: null,
        lastError: null,
        editActiveUntil: null,
        clientMessageId,
        version: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
        statusChangedAt: nowIso,
      }

      await db.scheduledMessages.put(toCached(optimistic, { localOnly: true }))
      await enqueueOperation(workspaceId, "schedule_message", {
        placeholderId,
        clientMessageId,
        input: { ...input, clientMessageId },
      })
      syncEngine.kickOperationQueue()

      // Invalidate queries so any TanStack-driven count/list refreshes pick
      // up the optimistic row alongside the live IDB query.
      queryClient.invalidateQueries({ queryKey: scheduledKeys.all })

      return optimistic
    },
  })
}

/**
 * Save a scheduled message via optimistic concurrency. The client sends the
 * `expectedVersion` it last saw on the row; the server CAS rejects with
 * `SCHEDULED_MESSAGE_STALE_VERSION` (409) when another save landed first.
 * Caller surfaces the stale error to the user as "edited elsewhere — refresh"
 * and the next list refresh pulls the latest content.
 */
export function useUpdateScheduled(workspaceId: string) {
  const scheduledService = useScheduledService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateScheduledMessageInput }) =>
      scheduledService.update(workspaceId, id, input),
    onSuccess: (scheduled) => {
      void persistScheduledRows([scheduled])
      queryClient.invalidateQueries({ queryKey: scheduledKeys.all })
    },
  })
}

/**
 * Cancel a pending scheduled message. Optimistic: row removed from IDB
 * immediately; the network call enqueues for retry on failure so a user who
 * cancels offline doesn't lose the intent.
 */
export function useCancelScheduled(workspaceId: string) {
  const scheduledService = useScheduledService()
  const queryClient = useQueryClient()
  const syncEngine = useSyncEngine()

  return useMutation({
    mutationFn: async (id: string) => {
      try {
        await scheduledService.delete(workspaceId, id)
      } catch {
        // Local placeholder rows have no server-side counterpart — just
        // dropping the placeholder is enough; the schedule op may still be
        // queued and will be a no-op for a row the user already cancelled.
        if (!isLocalScheduledId(id)) {
          await enqueueOperation(workspaceId, "cancel_scheduled_message", { id })
          syncEngine.kickOperationQueue()
        }
      }
    },
    onMutate: async (id) => {
      // Optimistic removal: the user expects the row to vanish immediately on
      // click. Worst case (server returns 409 because the worker won) we
      // rehydrate from the upserted socket event.
      const cached = await db.scheduledMessages.get(id)
      await removeScheduledRow(id)
      return { cached }
    },
    onError: (_err, _id, context) => {
      if (context?.cached) {
        void db.scheduledMessages.put(context.cached)
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: scheduledKeys.all })
    },
  })
}

/**
 * Pause the worker from sending while the user has the edit dialog open.
 * Fire-and-forget — the dialog calls this once on mount; the server bumps
 * the worker fence with a generous TTL (~10 min). No heartbeat. If the user
 * is still editing past the TTL, their save 409s cleanly via the
 * `expectedVersion` CAS and the dialog refreshes.
 */
export function useLockScheduledForEdit(workspaceId: string) {
  const scheduledService = useScheduledService()
  return useMutation({
    mutationFn: (id: string) => scheduledService.lockForEdit(workspaceId, id),
    onSuccess: (res) => {
      // Refresh IDB with the authoritative row — the dialog reads
      // `version` for its expectedVersion, and IDB rows that pre-date the
      // version migration would otherwise be missing it.
      void persistScheduledRows([res.scheduled])
    },
  })
}

/**
 * Release the worker fence on dialog close. Fire-and-forget; if the call
 * fails (offline, transient), the fence still expires on its own TTL —
 * the user just waits up to 10 minutes for the row to fire instead of the
 * worker firing immediately at scheduled_for. Without this, cancelling
 * out of the dialog leaves the row stranded behind the lock.
 */
export function useReleaseScheduledEditLock(workspaceId: string) {
  const scheduledService = useScheduledService()
  return useMutation({
    mutationFn: (id: string) => scheduledService.releaseEditLock(workspaceId, id),
  })
}

/**
 * Send a pending row immediately. Server takes the worker-style CAS and
 * fires through the same EventService.createMessage code path. On success the
 * row transitions sent and the live message appears in the stream timeline
 * via the standard message:created broadcast. On network failure, enqueues
 * for retry so the intent isn't lost offline.
 */
export function useSendScheduledNow(workspaceId: string) {
  const scheduledService = useScheduledService()
  const queryClient = useQueryClient()
  const syncEngine = useSyncEngine()

  return useMutation({
    mutationFn: async (id: string) => {
      try {
        return await scheduledService.sendNow(workspaceId, id)
      } catch (err) {
        if (!isLocalScheduledId(id)) {
          await enqueueOperation(workspaceId, "send_scheduled_now", { id })
          syncEngine.kickOperationQueue()
        }
        throw err
      }
    },
    onSuccess: (scheduled) => {
      if (scheduled) {
        void persistScheduledRows([scheduled])
        queryClient.invalidateQueries({ queryKey: scheduledKeys.all })
      }
    },
  })
}
