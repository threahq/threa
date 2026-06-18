import { useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { BotRuntimePresenceSummary } from "@threa/types"
import type { CachedStreamBootstrap } from "@/sync/stream-sync"
import type { CachedBot } from "@/db/database"
import { useWorkspaceBots } from "@/stores/workspace-store"
import { streamKeys } from "./use-streams"

export interface ActiveBotPresence {
  bot: CachedBot
  presence: BotRuntimePresenceSummary | null
}

/**
 * The external agent (bot runtime) attached to a scratchpad, or null when none
 * is. The stream's own surfaces (timeline, header) bootstrap and keep presence
 * fresh via the `bot_runtime:presence` socket event, so this is a cache-only
 * observer (`enabled: false`): it reflects that cache and re-renders on presence
 * updates without issuing its own fetch or room-join.
 */
export function useActiveBotPresence(
  workspaceId: string | undefined,
  streamId: string | undefined
): ActiveBotPresence | null {
  const queryClient = useQueryClient()
  const workspaceBots = useWorkspaceBots(workspaceId)

  const { data: bootstrap } = useQuery({
    queryKey: streamKeys.bootstrap(workspaceId ?? "", streamId ?? ""),
    queryFn: () =>
      queryClient.getQueryData<CachedStreamBootstrap>(streamKeys.bootstrap(workspaceId ?? "", streamId ?? "")) ?? null,
    enabled: false,
    staleTime: Infinity,
  })

  return useMemo(() => {
    const presence = bootstrap?.botRuntimePresence ?? {}
    const botIds = bootstrap?.botMemberIds ?? Object.keys(presence)
    const botId = botIds.find((candidate) => presence[candidate]) ?? botIds[0]
    if (!botId) return null
    const bot = workspaceBots.find((candidate) => candidate.id === botId)
    if (!bot) return null
    return { bot, presence: presence[botId] ?? null }
  }, [bootstrap?.botMemberIds, bootstrap?.botRuntimePresence, workspaceBots])
}
