import { useCallback, useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useUser } from "@/auth"
import { usePendingMessages } from "@/contexts"
import { db, sequenceToNum } from "@/db"
import { enqueueOperation } from "@/sync/operation-queue"
import { getLatestPersistedSequence } from "@/sync/stream-sync"
import { useOptionalSyncEngine } from "@/sync/sync-engine"
import { useWorkspaceUsers } from "@/stores/workspace-store"
import { AuthorTypes, CommandKinds, type StreamEvent } from "@threahq/types"
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

    const dispatched = await db.events.get([workspaceId, commandId])
    if (dispatched?.streamId !== streamId) return false

    await db.pendingOperations.bulkDelete(operations.map((operation) => operation.id))
    const eventIds = [commandId, `${commandId}:failed`]
    const events = await db.events.bulkGet(eventIds.map((id) => [workspaceId, id]))
    await db.events.bulkDelete(
      eventIds.filter((_, index) => events[index]?.streamId === streamId).map((id) => [workspaceId, id])
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
  const { revokeOptimisticEvent } = usePendingMessages()
  // The timeline only lets go of a published row once the cache carries it;
  // a cancelled row is deleted before that can happen, so it is taken back here.
  const cancel = useCallback(async () => {
    const cancelled = await cancelCommandDispatch(workspaceId, streamId, commandId)
    if (cancelled) revokeOptimisticEvent(commandId)
    return cancelled
  }, [commandId, revokeOptimisticEvent, streamId, workspaceId])
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
 * @param options.publishToTimeline - Put the row on the stream's timeline in the
 *   sending tick. Only for a composer whose stream timeline is on screen: the
 *   timeline is what takes a published row back, so a composer without one (the
 *   board page) would leave it on the next open of that stream.
 * @returns A callback that queues a slash command and resolves its optimistic event id.
 * @example
 * const { queueCommand } = useCommandDispatchQueue(workspaceId, streamId, { publishToTimeline: true })
 */
export function useCommandDispatchQueue(
  workspaceId: string,
  streamId: string,
  { publishToTimeline }: { publishToTimeline: boolean }
) {
  const user = useUser()
  const syncEngine = useOptionalSyncEngine()
  const { publishOptimisticEvent, revokeOptimisticEvent } = usePendingMessages()
  const idbUsers = useWorkspaceUsers(workspaceId)
  const currentUserId = useMemo(
    () => idbUsers.find((u) => u.workosUserId === user?.id)?.id ?? null,
    [idbUsers, user?.id]
  )

  const queueCommand = useCallback(
    async (params: { commandMarkdown: string; commandName: string; conversationId?: string }): Promise<string> => {
      if (!currentUserId) {
        throw new Error("Cannot dispatch command: user identity not resolved yet")
      }

      const optimisticEventId = `temp_cmd_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const now = new Date().toISOString()
      const optimisticEvent: Omit<StreamEvent, "sequence"> = {
        id: optimisticEventId,
        streamId,
        eventType: "command_dispatched",
        payload: {
          commandId: optimisticEventId,
          name: params.commandName,
          args: parseCommandArgs(params.commandMarkdown),
          status: "dispatched",
          ...(params.conversationId && { conversationId: params.conversationId }),
          executionKind: CommandKinds.BOT_RUNTIME,
        },
        actorId: currentUserId,
        actorType: AuthorTypes.USER,
        createdAt: now,
      }

      // Same contract as a message send: the row is on the timeline in this
      // tick, the durable copy below replaces it once the live query re-reads.
      const publishedSequence = Date.now().toString()
      if (publishToTimeline) {
        publishOptimisticEvent({
          ...optimisticEvent,
          workspaceId,
          sequence: publishedSequence,
          _sequenceNum: sequenceToNum(publishedSequence),
          _status: "pending",
          _cachedAt: Date.now(),
        })
      }

      try {
        await db.transaction("rw", [db.events, db.pendingOperations], async () => {
          const [anchorSequence, optimisticSequence] = await Promise.all([
            getLatestPersistedSequence(workspaceId, streamId),
            nextOptimisticSequence(workspaceId, streamId),
          ])
          await db.events.add({
            ...optimisticEvent,
            workspaceId,
            sequence: optimisticSequence,
            _sequenceNum: sequenceToNum(optimisticSequence),
            ...(anchorSequence != null && { _anchorSequenceNum: sequenceToNum(anchorSequence) }),
            _status: "pending",
            _cachedAt: Date.now(),
          })
          await enqueueOperation(workspaceId, "dispatch_command", {
            streamId,
            command: params.commandMarkdown,
            optimisticEventId,
            ...(params.conversationId && { conversationId: params.conversationId }),
          })
        })
      } catch (err) {
        revokeOptimisticEvent(optimisticEventId)
        throw err
      }

      syncEngine?.kickOperationQueue()
      return optimisticEventId
    },
    [currentUserId, publishOptimisticEvent, publishToTimeline, revokeOptimisticEvent, streamId, syncEngine, workspaceId]
  )

  return { queueCommand }
}
