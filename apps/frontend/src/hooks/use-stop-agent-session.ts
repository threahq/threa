import { useCallback } from "react"
import type { Socket } from "socket.io-client"
import { toast } from "sonner"
import { commandsApi } from "@/api"
import { CommandKinds } from "@threahq/types"
import { useAbortSession } from "./use-abort-session"

function advertisesRuntimeStop(commands: Awaited<ReturnType<typeof commandsApi.listForStream>>): boolean {
  return commands.some((command) => command.kind === CommandKinds.BOT_RUNTIME && command.name === "stop")
}

export function useStopAgentSession(socket: Socket | null, workspaceId: string, streamId: string) {
  const abortSession = useAbortSession(socket)

  return useCallback(
    (sessionId: string) => {
      void commandsApi
        .listForStream(workspaceId, streamId)
        .then(async (commands) => {
          if (!advertisesRuntimeStop(commands)) {
            abortSession({ sessionId, workspaceId })
            return
          }

          try {
            await commandsApi.dispatch(workspaceId, { streamId, command: "/stop" })
          } catch (error) {
            console.warn("[useStopAgentSession] /stop dispatch failed, falling back to local abort", error)
            toast.error("Runtime stop failed — using local stop instead")
            abortSession({ sessionId, workspaceId })
          }
        })
        .catch((error: unknown) => {
          console.warn("[useStopAgentSession] failed to resolve runtime stop command", error)
          toast.error("Failed to stop session")
          abortSession({ sessionId, workspaceId })
        })
    },
    [abortSession, streamId, workspaceId]
  )
}
