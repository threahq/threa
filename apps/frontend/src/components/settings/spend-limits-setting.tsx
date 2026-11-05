import type { AIBudgetConfig } from "@threahq/types"
import { useAIBudget } from "@/hooks"
import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { formatCurrency } from "@/components/ai-usage/metrics"
import { buildAIUsagePath } from "@/lib/stream-links"
import { SettingLinkRow } from "./setting-primitives"

function spendValue(budget: AIBudgetConfig, usedUsd: number): string {
  if (budget.aiDisabled || budget.operatorAiDisabled) return "AI turned off"
  const limit = Math.min(budget.monthlyBudgetUsd, budget.operatorCeilingUsd ?? budget.monthlyBudgetUsd)
  return `${formatCurrency(usedUsd)} of ${formatCurrency(limit, 0)} this month`
}

export function SpendLimitsSetting({ workspaceId }: { workspaceId: string }) {
  const timezone = useCachedWorkspaceBootstrap(workspaceId)?.workspaceSettings?.billingTimezone ?? null
  const { data } = useAIBudget(workspaceId, timezone)

  return (
    <SettingLinkRow
      setting="spend-limits"
      href={buildAIUsagePath(workspaceId)}
      value={data ? spendValue(data.budget, data.currentUsage.totalCostUsd) : undefined}
    />
  )
}
