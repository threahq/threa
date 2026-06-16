import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { aiUsageApi } from "@/api"
import type { UpdateAIBudgetInput, AIBudgetResponse } from "@threa/types"

export const aiUsageKeys = {
  all: ["ai-usage"] as const,
  usage: (workspaceId: string) => [...aiUsageKeys.all, "usage", workspaceId] as const,
  recentUsage: (workspaceId: string) => [...aiUsageKeys.all, "recent", workspaceId] as const,
  budget: (workspaceId: string) => [...aiUsageKeys.all, "budget", workspaceId] as const,
}

export function useAIUsage(workspaceId: string) {
  return useQuery({
    queryKey: aiUsageKeys.usage(workspaceId),
    queryFn: () => aiUsageApi.getUsage(workspaceId),
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

export function useAIBudget(workspaceId: string) {
  return useQuery({
    queryKey: aiUsageKeys.budget(workspaceId),
    queryFn: () => aiUsageApi.getBudget(workspaceId),
    enabled: !!workspaceId,
  })
}

export function useUpdateAIBudget(workspaceId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: UpdateAIBudgetInput) => aiUsageApi.updateBudget(workspaceId, input),
    onSuccess: (data: AIBudgetResponse) => {
      queryClient.setQueryData(aiUsageKeys.budget(workspaceId), data)
    },
  })
}
