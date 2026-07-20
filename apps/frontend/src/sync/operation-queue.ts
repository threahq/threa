import { db, sequenceToNum } from "@/db"
import type { CachedEvent, PendingOperation } from "@/db/database"
import type { CommandFailedPayload, ScheduleMessageInput, ScheduledMessageView } from "@threa/types"
import { ApiError, commandsApi, isPermanentApiError } from "@/api"
import { persistScheduledRows, removeScheduledRow, replaceLocalScheduledRow } from "@/hooks/use-scheduled"
import { executeDraftDelete, executeDraftResolve, executeDraftUpsert, type DraftsServiceLike } from "./draft-sync"

function getRetryDelay(retryCount: number): number {
  if (retryCount <= 3) return 0
  if (retryCount <= 6) return 5_000
  if (retryCount <= 10) return 30_000
  return 120_000
}

function generateId(): string {
  return `op_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

interface MessageServiceLike {
  update: (wid: string, mid: string, data: any) => Promise<any>
  delete: (wid: string, mid: string) => Promise<void>
}

interface ReactionServiceLike {
  add: (wid: string, mid: string, emoji: string) => Promise<void>
  remove: (wid: string, mid: string, emoji: string) => Promise<void>
}

interface ScheduledServiceLike {
  create: (workspaceId: string, input: ScheduleMessageInput) => Promise<ScheduledMessageView>
  delete: (workspaceId: string, id: string) => Promise<void>
  sendNow: (workspaceId: string, id: string) => Promise<ScheduledMessageView>
}

/**
 * A permanently-rejected op's local optimistic state must be unwound, or the
 * UI keeps offering an action the server will always refuse (the user re-taps,
 * a fresh op enqueues, and the queue grows a phantom-row loop). Scheduled ops
 * evict the local row — bootstrap/socket events restore the server's truth.
 */
async function reconcileRejectedOperation(op: PendingOperation): Promise<void> {
  switch (op.type) {
    case "schedule_message":
      await removeScheduledRow(op.payload.placeholderId as string)
      break
    case "send_scheduled_now":
    case "cancel_scheduled_message":
      await removeScheduledRow(op.payload.id as string)
      break
  }
}

async function markCommandDispatchFailed(workspaceId: string, optimisticEventId: string, error: Error): Promise<void> {
  await db.transaction("rw", db.events, async () => {
    const dispatched = await db.events.get(optimisticEventId)
    if (!dispatched) return
    const failedSequence = (Number(dispatched.sequence) + 1).toString()
    const failedEvent: CachedEvent = {
      id: `${optimisticEventId}:failed`,
      workspaceId,
      streamId: dispatched.streamId,
      sequence: failedSequence,
      eventType: "command_failed",
      payload: {
        commandId: optimisticEventId,
        error: error.message,
      } satisfies CommandFailedPayload,
      actorId: dispatched.actorId,
      actorType: dispatched.actorType,
      createdAt: new Date().toISOString(),
      _sequenceNum: sequenceToNum(failedSequence),
      _status: "failed",
      _cachedAt: Date.now(),
    }
    await db.events.update(optimisticEventId, { _status: "failed" })
    await db.events.put(failedEvent)
  })
}

/**
 * Enqueue an offline operation. Writes to IDB and returns immediately.
 * The operation will be processed when the SyncEngine kicks the queue
 * (on connect/reconnect) or when explicitly kicked via the SyncEngine.
 */
export async function enqueueOperation(
  workspaceId: string,
  type: PendingOperation["type"],
  payload: Record<string, unknown>
): Promise<void> {
  await db.pendingOperations.add({
    id: generateId(),
    workspaceId,
    type,
    payload,
    createdAt: Date.now(),
    retryCount: 0,
  })
}

/**
 * Process pending operations from IDB. Called on socket connect/reconnect.
 * Uses Web Locks to prevent cross-tab double-processing.
 */
export async function processOperationQueue(
  messageService: MessageServiceLike,
  reactionService: ReactionServiceLike,
  scheduledService: ScheduledServiceLike | undefined,
  draftsService: DraftsServiceLike | undefined,
  isOnline: () => boolean
): Promise<void> {
  const processor = async () => {
    const now = Date.now()
    const skipped = new Set<string>()

    while (true) {
      if (!isOnline()) break

      const candidates = await db.pendingOperations.orderBy("createdAt").toArray()
      const next = candidates.find((op) => !skipped.has(op.id) && (op.retryAfter ?? 0) <= now)
      if (!next) break

      try {
        // Mark the attempt BEFORE executing: once a request may have left the
        // device, a coalescing replace of this op must carry its idempotency
        // lineage (writeId) forward instead of minting a fresh one — otherwise
        // a committed-but-unacked write reads as drift and splits server-side.
        const claimed = await db.pendingOperations.update(next.id, {
          startedAt: Date.now(),
          ...(next.type === "dispatch_command" && { attempting: true }),
        })
        if (claimed === 0) continue
        await executeOperation(next, messageService, reactionService, scheduledService, draftsService)
        await db.pendingOperations.delete(next.id)
      } catch (error) {
        if (isPermanentApiError(error)) {
          // A 4xx (minus 408/429) is the server's final answer for this
          // payload — replaying it can never succeed, so the op must die
          // here or it refires on every queue kick forever (the prod
          // send-now denial loop of 2026-07-19).
          await reconcileRejectedOperation(next)
          await db.pendingOperations.delete(next.id)
        } else {
          const retryCount = next.retryCount + 1
          await db.pendingOperations.update(next.id, {
            retryCount,
            retryAfter: Date.now() + getRetryDelay(retryCount),
            ...(next.type === "dispatch_command" && { attempting: false }),
          })
          skipped.add(next.id)
        }
      }
    }
  }

  if (navigator.locks) {
    await navigator.locks.request("threa-operation-queue", { ifAvailable: true }, async (lock) => {
      if (!lock) return
      await processor()
    })
  } else {
    await processor()
  }
}

async function executeOperation(
  op: PendingOperation,
  messageService: MessageServiceLike,
  reactionService: ReactionServiceLike,
  scheduledService: ScheduledServiceLike | undefined,
  draftsService: DraftsServiceLike | undefined
): Promise<void> {
  const { workspaceId, type, payload } = op

  switch (type) {
    case "edit_message":
      await messageService.update(workspaceId, payload.messageId as string, {
        contentJson: payload.contentJson as import("@threa/types").JSONContent,
      })
      break

    case "delete_message":
      await messageService.delete(workspaceId, payload.messageId as string)
      break

    case "add_reaction":
      await reactionService.add(workspaceId, payload.messageId as string, payload.emoji as string)
      break

    case "remove_reaction":
      await reactionService.remove(workspaceId, payload.messageId as string, payload.emoji as string)
      break

    case "schedule_message": {
      if (!scheduledService) throw new Error("scheduledService is required to replay schedule_message ops")
      const placeholderId = payload.placeholderId as string
      const input = payload.input as ScheduleMessageInput
      const created = await scheduledService.create(workspaceId, input)
      // Swap the local placeholder for the server row in one transaction so
      // the live Dexie query never observes a frame with neither row present.
      await replaceLocalScheduledRow(placeholderId, created)
      break
    }

    case "cancel_scheduled_message": {
      if (!scheduledService) throw new Error("scheduledService is required to replay cancel_scheduled_message ops")
      await scheduledService.delete(workspaceId, payload.id as string)
      break
    }

    case "send_scheduled_now": {
      if (!scheduledService) throw new Error("scheduledService is required to replay send_scheduled_now ops")
      const sent = await scheduledService.sendNow(workspaceId, payload.id as string)
      await persistScheduledRows([sent])
      break
    }

    case "update_scheduled_message":
      // Updates carry an `expectedVersion` snapshot — once that version is
      // stale (the user finished a session and another save landed), the
      // server returns STALE_VERSION which is not a transient failure. We
      // deliberately do NOT enqueue updates; the editor surfaces the conflict
      // synchronously and the user re-saves with the latest version.
      throw new Error("update_scheduled_message replay is not implemented")

    case "dispatch_command": {
      const optimisticEventId = payload.optimisticEventId as string
      try {
        const result = await commandsApi.dispatch(workspaceId, {
          streamId: payload.streamId as string,
          command: payload.command as string,
        })
        if (!result.success) throw new ApiError(400, "COMMAND_DISPATCH_FAILED", result.error)
        await db.transaction("rw", db.events, async () => {
          if (!(await db.events.get(optimisticEventId))) return
          await db.events.delete(optimisticEventId)
          await db.events.put({
            ...result.event,
            workspaceId,
            _sequenceNum: sequenceToNum(result.event.sequence),
            _cachedAt: Date.now(),
          })
        })
      } catch (error) {
        if (!isPermanentApiError(error)) throw error
        await markCommandDispatchFailed(workspaceId, optimisticEventId, error)
      }
      break
    }

    case "upsert_draft": {
      // Silent retry, no error surface (a failed draft save is invisible — the
      // local copy stands). Reads the draft fresh and reconciles split/version.
      // Without a drafts service this context is local-only: drop the op rather
      // than throw (a throw would retry forever, never reaching a service).
      if (!draftsService) break
      const priorWriteIds = Array.isArray(payload.priorWriteIds)
        ? payload.priorWriteIds.filter((id): id is string => typeof id === "string")
        : []
      await executeDraftUpsert(
        workspaceId,
        payload.draftId as string,
        payload.writeId as string,
        draftsService,
        priorWriteIds
      )
      break
    }

    case "resolve_draft": {
      // CAS clear-on-send (silent retry, no error surface). Drops the server row
      // only if `expectedVersion` still matches; a drifted copy survives. Without
      // a drafts service this context is local-only — drop the op (a throw would
      // retry forever, never reaching a service).
      if (!draftsService) break
      const supersededWriteIds = Array.isArray(payload.supersededWriteIds)
        ? payload.supersededWriteIds.filter((id): id is string => typeof id === "string")
        : []
      await executeDraftResolve(
        workspaceId,
        payload.draftId as string,
        payload.expectedVersion as number,
        draftsService,
        supersededWriteIds
      )
      break
    }

    case "delete_draft": {
      if (!draftsService) break
      const supersededWriteIds = Array.isArray(payload.supersededWriteIds)
        ? payload.supersededWriteIds.filter((id): id is string => typeof id === "string")
        : []
      await executeDraftDelete(workspaceId, payload.draftId as string, draftsService, supersededWriteIds)
      break
    }
  }
}
