import { useCallback, useMemo } from "react"
import { useUser } from "@/auth"
import { db, sequenceToNum } from "@/db"
import { enqueueOperation } from "@/sync/operation-queue"
import { useOptionalSyncEngine } from "@/sync/sync-engine"
import { useWorkspaceUsers } from "@/stores/workspace-store"
import { AuthorTypes, CommandKinds, type StreamEvent } from "@threa/types"

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

      const optimisticEventId = `temp_cmd_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const now = new Date().toISOString()
      const optimisticEvent: StreamEvent = {
        id: optimisticEventId,
        streamId,
        sequence: Date.now().toString(),
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
