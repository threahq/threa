import { useCallback, useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useUser } from "@/auth"
import { db, sequenceToNum } from "@/db"
import { enqueueOperation } from "@/sync/operation-queue"
import { getLatestPersistedSequence } from "@/sync/stream-sync"
import { useOptionalSyncEngine } from "@/sync/sync-engine"
import { useWorkspaceUsers } from "@/stores/workspace-store"
import { AuthorTypes, CommandKinds, type StreamEvent } from "@threa/types"
import { nextOptimisticSequence } from "@/lib/optimistic-sequence"

/**
 * Removes a cancellable optimistic command and its queued dispatch.
 *
 * @param workspaceId - Workspace that owns the command.
 * @param streamId - Stream that owns the optimistic event.
 * @param commandId - Optimistic command event identifier.
 * @returns Whether the command was still cancellable and was removed.
 * @example
 * await cancelCommandDispatch("ws_123", "stream_123", "temp_cmd_123")
 */
export async function cancelCommandDispatch(
  workspaceId: string,
  streamId: string,
  commandId: string
): Promise<boolean> {
  return db.transaction("rw", [db.events, db.pendingOperations], async () => {
    const operations = (await db.pendingOperations.where("type").equals("dispatch_command").toArray()).filter(
      (operation) => operation.workspaceId === workspaceId && operation.payload.optimisticEventId === commandId
    )
    if (operations.some((operation) => operation.startedAt != null)) return false

    const dispatched = await db.events.get(commandId)
    if (dispatched?.workspaceId !== workspaceId || dispatched.streamId !== streamId) return false

    await db.pendingOperations.bulkDelete(operations.map((operation) => operation.id))
    const eventIds = [commandId, `${commandId}:failed`]
    const events = await db.events.bulkGet(eventIds)
    await db.events.bulkDelete(
      eventIds.filter((_, index) => {
        const event = events[index]
        return event?.workspaceId === workspaceId && event.streamId === streamId
      })
    )
    return true
  })
}

/**
 * Observes whether a local command can be cancelled and exposes its cancellation action.
 *
 * @param workspaceId - Workspace that owns the command.
 * @param streamId - Stream that owns the command.
 * @param commandId - Optimistic command event identifier.
 * @param localStatus - Current local optimistic status.
 * @returns Reactive cancellation eligibility and callback.
 * @example
 * const { canCancel, cancel } = useCommandDispatchCancellation(workspaceId, streamId, commandId, status)
 */
export function useCommandDispatchCancellation(
  workspaceId: string,
  streamId: string,
  commandId: string,
  localStatus: string | undefined
) {
  const operation = useLiveQuery(
    async () =>
      (await db.pendingOperations
        .where("type")
        .equals("dispatch_command")
        .filter(
          (candidate) => candidate.workspaceId === workspaceId && candidate.payload.optimisticEventId === commandId
        )
        .first()) ?? null,
    [commandId, workspaceId],
    undefined
  )
  const canCancel =
    localStatus === "failed" || (localStatus === "pending" && operation != null && operation.startedAt == null)
  const cancel = useCallback(
    () => cancelCommandDispatch(workspaceId, streamId, commandId),
    [commandId, streamId, workspaceId]
  )
  return { canCancel, cancel }
}

function parseCommandArgs(commandMarkdown: string): string {
  const trimmed = commandMarkdown.trim()
  const withoutSlash = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed
  const firstSpace = withoutSlash.search(/\s/)
  if (firstSpace === -1) return ""
  return withoutSlash.slice(firstSpace).trim()
}

/**
 * Creates optimistic command events and queues their durable dispatch operations.
 *
 * @param workspaceId - Workspace receiving the command.
 * @param streamId - Stream receiving the command.
 * @returns A callback that queues a slash command.
 * @example
 * const { queueCommand } = useCommandDispatchQueue(workspaceId, streamId)
 */
export function useCommandDispatchQueue(workspaceId: string, streamId: string) {
  const user = useUser()
  const syncEngine = useOptionalSyncEngine()
  const idbUsers = useWorkspaceUsers(workspaceId)
  const currentUserId = useMemo(
    () => idbUsers.find((u) => u.workosUserId === user?.id)?.id ?? null,
    [idbUsers, user?.id]
  )

  const queueCommand = useCallback(
    async (params: { commandMarkdown: string; commandName: string }) => {
      if (!currentUserId) {
        throw new Error("Cannot dispatch command: user identity not resolved yet")
      }

      const optimisticEventId = `temp_cmd_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const now = new Date().toISOString()

      await db.transaction("rw", [db.events, db.pendingOperations], async () => {
        const [anchorSequence, optimisticSequence] = await Promise.all([
          getLatestPersistedSequence(streamId),
          nextOptimisticSequence(streamId),
        ])
        const optimisticEvent: StreamEvent = {
          id: optimisticEventId,
          streamId,
          sequence: optimisticSequence,
          eventType: "command_dispatched",
          payload: {
            commandId: optimisticEventId,
            name: params.commandName,
            args: parseCommandArgs(params.commandMarkdown),
            status: "dispatched",
            executionKind: CommandKinds.BOT_RUNTIME,
          },
          actorId: currentUserId,
          actorType: AuthorTypes.USER,
          createdAt: now,
        }
        await db.events.add({
          ...optimisticEvent,
          workspaceId,
          _sequenceNum: sequenceToNum(optimisticSequence),
          ...(anchorSequence != null && { _anchorSequenceNum: sequenceToNum(anchorSequence) }),
          _status: "pending",
          _cachedAt: Date.now(),
        })
        await enqueueOperation(workspaceId, "dispatch_command", {
          streamId,
          command: params.commandMarkdown,
          optimisticEventId,
        })
      })

      syncEngine?.kickOperationQueue()
    },
    [currentUserId, streamId, syncEngine, workspaceId]
  )

  return { queueCommand }
}
