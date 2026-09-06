import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { aiUsageApi } from "@/api"
import type { UpdateAIBudgetInput, AIBudgetResponse } from "@threahq/types"

// Usage and budget responses are bucketed into days and a month window by the
// timezone the caller asks for, so the zone is part of the identity of the
// cached data — not just a fetch detail.
export const aiUsageKeys = {
  all: ["ai-usage"] as const,
  usage: (workspaceId: string, timezone: string) => [...aiUsageKeys.all, "usage", workspaceId, timezone] as const,
  recentUsage: (workspaceId: string) => [...aiUsageKeys.all, "recent", workspaceId] as const,
  budget: (workspaceId: string, timezone: string) => [...aiUsageKeys.all, "budget", workspaceId, timezone] as const,
}

/**
 * `timezone` is null while the reporting zone is still unknown (the workspace
 * zone before bootstrap lands). Fetching under a guessed zone would return a
 * whole month of the wrong window, so the query holds instead.
 */
export function useAIUsage(workspaceId: string, timezone: string | null) {
  return useQuery({
    queryKey: aiUsageKeys.usage(workspaceId, timezone ?? "unresolved"),
    queryFn: () => aiUsageApi.getUsage(workspaceId, timezone!),
    enabled: !!workspaceId && timezone !== null,
  })
}

export function useAIRecentUsage(workspaceId: string, limit?: number) {
  return useQuery({
    queryKey: aiUsageKeys.recentUsage(workspaceId),
    queryFn: () => aiUsageApi.getRecentUsage(workspaceId, limit),
    enabled: !!workspaceId,
  })
}

export function useAIBudget(workspaceId: string, timezone: string | null) {
  return useQuery({
    queryKey: aiUsageKeys.budget(workspaceId, timezone ?? "unresolved"),
    queryFn: () => aiUsageApi.getBudget(workspaceId, timezone!),
    enabled: !!workspaceId && timezone !== null,
  })
}

export function useUpdateAIBudget(workspaceId: string, timezone: string | null) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: UpdateAIBudgetInput) => {
      // The controls are gated on loaded budget data, which cannot arrive under
      // an unresolved zone — so this is a wiring bug, not a user-reachable state.
      if (timezone === null) throw new Error("Cannot update the budget before the reporting timezone resolves")
      return aiUsageApi.updateBudget(workspaceId, timezone, input)
    },
    onSuccess: (data: AIBudgetResponse) => {
      queryClient.setQueryData(aiUsageKeys.budget(workspaceId, timezone ?? "unresolved"), data)
      // The budget itself is timezone-independent; only the usage window the
      // response reports it against isn't. Drop the other zones' copies so a
      // switch back doesn't show the pre-edit budget.
      queryClient.invalidateQueries({
        queryKey: [...aiUsageKeys.all, "budget", workspaceId],
        predicate: (query) => query.queryKey[query.queryKey.length - 1] !== timezone,
      })
    },
  })
}
