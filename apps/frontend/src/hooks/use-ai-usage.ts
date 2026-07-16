import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { aiUsageApi } from "@/api"
import type { UpdateAIBudgetInput, AIBudgetResponse } from "@threa/types"

// Usage and budget responses are bucketed into days and a month window by the
// timezone the caller asks for, so the zone is part of the identity of the
// cached data — not just a fetch detail.
export const aiUsageKeys = {
  all: ["ai-usage"] as const,
  usage: (workspaceId: string, timezone: string) => [...aiUsageKeys.all, "usage", workspaceId, timezone] as const,
  recentUsage: (workspaceId: string) => [...aiUsageKeys.all, "recent", workspaceId] as const,
  budget: (workspaceId: string, timezone: string) => [...aiUsageKeys.all, "budget", workspaceId, timezone] as const,
}

export function useAIUsage(workspaceId: string, timezone: string) {
  return useQuery({
    queryKey: aiUsageKeys.usage(workspaceId, timezone),
    queryFn: () => aiUsageApi.getUsage(workspaceId, timezone),
    enabled: !!workspaceId,
  })
}

export function useAIRecentUsage(workspaceId: string, limit?: number) {
  return useQuery({
    queryKey: aiUsageKeys.recentUsage(workspaceId),
    queryFn: () => aiUsageApi.getRecentUsage(workspaceId, limit),
    enabled: !!workspaceId,
  })
}

export function useAIBudget(workspaceId: string, timezone: string) {
  return useQuery({
    queryKey: aiUsageKeys.budget(workspaceId, timezone),
    queryFn: () => aiUsageApi.getBudget(workspaceId, timezone),
    enabled: !!workspaceId,
  })
}

export function useUpdateAIBudget(workspaceId: string, timezone: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: UpdateAIBudgetInput) => aiUsageApi.updateBudget(workspaceId, timezone, input),
    onSuccess: (data: AIBudgetResponse) => {
      queryClient.setQueryData(aiUsageKeys.budget(workspaceId, timezone), data)
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
