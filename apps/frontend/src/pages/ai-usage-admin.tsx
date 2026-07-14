import { useCallback, useEffect, useMemo, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft, DollarSign } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAIBudget, useAIUsage, useUpdateAIBudget } from "@/hooks"
import { useWorkspaceUsers } from "@/stores/workspace-store"
import { BudgetControlsPanel } from "@/components/ai-usage/budget-controls-panel"
import { BudgetHealthHero } from "@/components/ai-usage/budget-health-hero"
import { CapabilityBreakdown } from "@/components/ai-usage/capability-breakdown"
import { DailySpendChart } from "@/components/ai-usage/daily-spend-chart"
import { computeMetrics, type BudgetMetrics } from "@/components/ai-usage/metrics"
import { TopSpendersCard, UsageSplitCard } from "@/components/ai-usage/usage-breakdown"
import { SidebarToggle } from "@/components/layout"

export function AIUsageAdminPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const idbUsers = useWorkspaceUsers(workspaceId ?? "")

  const { data: usage, isLoading: usageLoading } = useAIUsage(workspaceId ?? "")
  const { data: budget, isLoading: budgetLoading } = useAIBudget(workspaceId ?? "")

  // Local state for inline-editable budget + hard limit. Synced from server,
  // committed on blur.
  const initialBudget = budget?.budget?.monthlyBudgetUsd ?? 50
  const initialHardLimit = budget?.budget?.hardLimitPercent ?? 100
  const [localBudget, setLocalBudget] = useState<string>(String(initialBudget))
  const [localHardLimit, setLocalHardLimit] = useState<string>(String(initialHardLimit))

  const updateBudget = useUpdateAIBudget(workspaceId ?? "")

  useEffect(() => {
    if (budget?.budget?.monthlyBudgetUsd !== undefined) {
      setLocalBudget(budget.budget.monthlyBudgetUsd.toString())
    }
  }, [budget?.budget?.monthlyBudgetUsd])

  useEffect(() => {
    if (budget?.budget?.hardLimitPercent !== undefined) {
      setLocalHardLimit(budget.budget.hardLimitPercent.toString())
    }
  }, [budget?.budget?.hardLimitPercent])

  const handleBudgetCommit = useCallback(() => {
    const value = parseFloat(localBudget)
    const serverValue = budget?.budget?.monthlyBudgetUsd
    if (!isNaN(value) && value >= 0) {
      if (value !== serverValue) {
        updateBudget.mutate({ monthlyBudgetUsd: value })
      }
    } else if (serverValue !== undefined) {
      // Invalid entry — revert the input so the display matches the server.
      setLocalBudget(serverValue.toString())
    }
  }, [localBudget, budget?.budget?.monthlyBudgetUsd, updateBudget])

  const handleHardLimitCommit = useCallback(() => {
    const value = parseInt(localHardLimit, 10)
    const serverValue = budget?.budget?.hardLimitPercent
    if (!isNaN(value) && value >= 100 && value <= 500) {
      if (value !== serverValue) {
        updateBudget.mutate({ hardLimitPercent: value })
      }
    } else if (serverValue !== undefined) {
      // Invalid entry — revert the input so the display matches the server.
      setLocalHardLimit(serverValue.toString())
    }
  }, [localHardLimit, budget?.budget?.hardLimitPercent, updateBudget])

  const userNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const user of idbUsers) {
      map.set(user.id, user.name || user.email || user.slug)
    }
    return map
  }, [idbUsers])

  const systemCost = useMemo(() => {
    if (!usage?.byOrigin) return 0
    const systemUsage = usage.byOrigin.find((o) => o.origin === "system")
    return systemUsage?.totalCostUsd ?? 0
  }, [usage?.byOrigin])

  const assistantCost = useMemo(() => {
    if (!usage?.byUser) return 0
    return usage.byUser.filter((u) => u.userId !== null).reduce((sum, u) => sum + u.totalCostUsd, 0)
  }, [usage?.byUser])

  // Reflect in-flight input values in metrics so the chart (budget line,
  // hard-limit line, zone tints) responds immediately as the user edits.
  const optimisticBudget = useMemo(() => {
    const parsed = parseFloat(localBudget)
    if (!isNaN(parsed) && parsed >= 0) return parsed
    return budget?.budget?.monthlyBudgetUsd ?? 50
  }, [localBudget, budget?.budget?.monthlyBudgetUsd])

  const optimisticHardLimitPercent = useMemo(() => {
    const parsed = parseInt(localHardLimit, 10)
    if (!isNaN(parsed) && parsed >= 100 && parsed <= 500) return parsed
    return budget?.budget?.hardLimitPercent ?? 100
  }, [localHardLimit, budget?.budget?.hardLimitPercent])

  const metrics = useMemo<BudgetMetrics>(
    () =>
      computeMetrics({
        totalCost: usage?.total.totalCostUsd ?? 0,
        budgetAmount: optimisticBudget,
        percentUsed: optimisticBudget > 0 ? ((usage?.total.totalCostUsd ?? 0) / optimisticBudget) * 100 : 0,
        periodStart: usage?.period.start ?? new Date().toISOString(),
        periodEnd: usage?.period.end ?? new Date().toISOString(),
        hardLimitEnabled: budget?.budget?.hardLimitEnabled ?? false,
        hardLimitPercent: optimisticHardLimitPercent,
      }),
    [
      usage?.total.totalCostUsd,
      usage?.period.start,
      usage?.period.end,
      optimisticBudget,
      budget?.budget?.hardLimitEnabled,
      optimisticHardLimitPercent,
    ]
  )

  if (!workspaceId) {
    return null
  }

  const isLoading = usageLoading || budgetLoading

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 items-center gap-2 border-b px-4">
        <SidebarToggle location="page" />
        <Link to={`/w/${workspaceId}`}>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex items-center gap-2">
          <DollarSign className="h-5 w-5 text-muted-foreground" />
          <h1 className="font-semibold">AI Usage &amp; Budget</h1>
        </div>
      </header>
      <main className="flex-1 overflow-auto p-4 sm:p-6">
        <div className="mx-auto max-w-6xl space-y-6">
          <BudgetHealthHero metrics={metrics} isLoading={isLoading} />

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="space-y-6">
              <DailySpendChart
                byDay={usage?.byDay ?? []}
                periodStart={usage?.period.start ?? new Date().toISOString()}
                periodEnd={usage?.period.end ?? new Date().toISOString()}
                isLoading={usageLoading}
              />
              <CapabilityBreakdown
                byFunction={usage?.byFunction ?? []}
                byModel={usage?.byModel ?? []}
                totalCost={usage?.total.totalCostUsd ?? 0}
                isLoading={usageLoading}
              />
              <UsageSplitCard
                systemCost={systemCost}
                assistantCost={assistantCost}
                totalCost={usage?.total.totalCostUsd ?? 0}
                isLoading={usageLoading}
              />
              <TopSpendersCard
                byUser={usage?.byUser ?? []}
                userNames={userNames}
                assistantTotal={assistantCost}
                isLoading={usageLoading}
              />
            </div>

            <div className="lg:sticky lg:top-6 lg:self-start">
              <BudgetControlsPanel
                workspaceId={workspaceId}
                budget={budget?.budget ?? null}
                nextReset={budget?.nextReset ?? new Date().toISOString()}
                metrics={metrics}
                localBudget={localBudget}
                onBudgetChange={setLocalBudget}
                onBudgetCommit={handleBudgetCommit}
                localHardLimit={localHardLimit}
                onHardLimitChange={setLocalHardLimit}
                onHardLimitCommit={handleHardLimitCommit}
                isLoading={budgetLoading}
              />
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
