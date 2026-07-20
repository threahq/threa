import { useCallback, useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useUser } from "@/auth"
import { db, sequenceToNum } from "@/db"
import { enqueueOperation } from "@/sync/operation-queue"
import { useOptionalSyncEngine } from "@/sync/sync-engine"
import { useWorkspaceUsers } from "@/stores/workspace-store"
import { AuthorTypes, CommandKinds, type StreamEvent } from "@threa/types"
import { nextOptimisticSequence } from "@/lib/optimistic-sequence"

export async function cancelCommandDispatch(streamId: string, commandId: string): Promise<boolean> {
  return db.transaction("rw", [db.events, db.pendingOperations], async () => {
    const operations = (await db.pendingOperations.where("type").equals("dispatch_command").toArray()).filter(
      (operation) => operation.payload.optimisticEventId === commandId
    )
    if (operations.some((operation) => operation.attempting)) return false

    const dispatched = await db.events.get(commandId)
    if (dispatched?.streamId !== streamId) return false

    await db.pendingOperations.bulkDelete(operations.map((operation) => operation.id))
    await db.events.bulkDelete([commandId, `${commandId}:failed`])
    return true
  })
}

export function useCommandDispatchCancellation(streamId: string, commandId: string, localStatus: string | undefined) {
  const operation = useLiveQuery(
    async () =>
      (await db.pendingOperations
        .where("type")
        .equals("dispatch_command")
        .filter((candidate) => candidate.payload.optimisticEventId === commandId)
        .first()) ?? null,
    [commandId],
    undefined
  )
  const canCancel =
    localStatus === "failed" || (localStatus === "pending" && operation != null && !operation.attempting)
  const cancel = useCallback(() => cancelCommandDispatch(streamId, commandId), [commandId, streamId])
  return { canCancel, cancel }
}

function parseCommandArgs(commandMarkdown: string): string {
  const trimmed = commandMarkdown.trim()
  const withoutSlash = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed
  const firstSpace = withoutSlash.search(/\s/)
  if (firstSpace === -1) return ""
  return withoutSlash.slice(firstSpace).trim()
}

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

      const optimisticSequence = nextOptimisticSequence()
      const optimisticEventId = `temp_cmd_${optimisticSequence}_${Math.random().toString(36).slice(2)}`
      const now = new Date().toISOString()
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

      await db.transaction("rw", [db.events, db.pendingOperations], async () => {
        await db.events.add({
          ...optimisticEvent,
          workspaceId,
          _sequenceNum: sequenceToNum(optimisticEvent.sequence),
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
