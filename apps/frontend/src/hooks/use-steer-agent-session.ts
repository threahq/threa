import { useCallback } from "react"
import { commandsApi } from "@/api"
import { CommandKinds } from "@threa/types"
import { queueComposerCommandRequest } from "@/stores/composer-command-request-store"

export function useSteerAgentSession(workspaceId: string, streamId: string) {
  return useCallback(async () => {
    try {
      const commands = await commandsApi.listForStream(workspaceId, streamId)
      const advertised = commands.some(
        (command) => command.kind === CommandKinds.BOT_RUNTIME && command.name === "steer"
      )
      if (advertised) queueComposerCommandRequest(streamId, "/steer ")
    } catch (error) {
      console.warn("[useSteerAgentSession] failed to resolve runtime steer command", error)
    }
  }, [streamId, workspaceId])
}
