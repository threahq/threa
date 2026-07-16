import { useCallback } from "react"
import { Bell, Shield } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { useUpdateAIBudget } from "@/hooks"
import type { UpdateAIBudgetInput } from "@threa/types"
import { cn } from "@/lib/utils"
import { formatCurrency, type BudgetMetrics } from "./metrics"
import { SectionLabel } from "./primitives"

export function BudgetControlsPanel({
  workspaceId,
  reportingTimezone,
  budget,
  nextReset,
  metrics,
  localBudget,
  onBudgetChange,
  onBudgetCommit,
  localHardLimit,
  onHardLimitChange,
  onHardLimitCommit,
  isLoading,
}: {
  workspaceId: string
  budget: {
    monthlyBudgetUsd: number
    alertThreshold50: boolean
    alertThreshold80: boolean
    alertThreshold100: boolean
    degradationEnabled: boolean
    hardLimitEnabled: boolean
    hardLimitPercent: number
  } | null
  nextReset: string
  /**
   * The zone the dashboard's month window is drawn in. Keys the budget mutation
   * to the same cached response the page reads, and names the reset date.
   */
  reportingTimezone: string
  metrics: BudgetMetrics
  localBudget: string
  onBudgetChange: (v: string) => void
  onBudgetCommit: () => void
  localHardLimit: string
  onHardLimitChange: (v: string) => void
  onHardLimitCommit: () => void
  isLoading: boolean
}) {
  const updateBudget = useUpdateAIBudget(workspaceId, reportingTimezone)

  const handleUpdate = useCallback(
    (updates: UpdateAIBudgetInput) => {
      updateBudget.mutate(updates)
    },
    [updateBudget]
  )

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">Cost controls</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[420px] w-full" />
        </CardContent>
      </Card>
    )
  }

  const resetDate = new Date(nextReset)
  // The reset lands on the reporting zone's month boundary, so it is named in
  // that zone — device-local would contradict the cycle the hero just drew.
  // Identical in the default mode, where the reporting zone is the device's.
  const resetDateStr = resetDate.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: reportingTimezone,
  })

  const usedPct = metrics.percentUsed
  const thresholdHit = (t: number) => usedPct >= t

  return (
    <Card>
      <CardHeader className="pb-3">
        <SectionLabel>Controls</SectionLabel>
        <CardTitle className="text-base font-medium">Budget &amp; guardrails</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label
            htmlFor="monthly-budget"
            className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Monthly budget
          </Label>
          <div className="flex items-baseline gap-1 border-b border-border pb-1 focus-within:border-primary">
            <span className="text-lg font-semibold tabular-nums text-muted-foreground">$</span>
            <Input
              id="monthly-budget"
              type="number"
              min="0"
              step="1"
              value={localBudget}
              onChange={(e) => onBudgetChange(e.target.value)}
              onBlur={onBudgetCommit}
              className="h-auto w-full rounded-none border-0 bg-transparent px-0 text-2xl font-semibold tabular-nums shadow-none focus-visible:ring-0"
              aria-label="Monthly budget"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Resets {resetDateStr} · currently {formatCurrency(metrics.totalCost)} of{" "}
            {formatCurrency(metrics.budgetAmount, 0)} used
          </p>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Bell className="h-3.5 w-3.5 text-muted-foreground" />
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Alert thresholds</h4>
          </div>
          <div className="space-y-2">
            {[
              {
                pct: 50,
                id: "alert-50",
                title: "Halfway",
                checked: budget?.alertThreshold50 ?? true,
                key: "alertThreshold50" as const,
              },
              {
                pct: 80,
                id: "alert-80",
                title: "Approaching limit",
                checked: budget?.alertThreshold80 ?? true,
                key: "alertThreshold80" as const,
              },
              {
                pct: 100,
                id: "alert-100",
                title: "Budget exhausted",
                checked: budget?.alertThreshold100 ?? true,
                key: "alertThreshold100" as const,
              },
            ].map((t) => {
              const hit = thresholdHit(t.pct)
              const thresholdAmount = metrics.budgetAmount * (t.pct / 100)
              return (
                <div
                  key={t.id}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-md border border-border/60 p-3 transition-colors",
                    hit && t.checked && "border-amber-500/40 bg-amber-500/5"
                  )}
                >
                  <Label htmlFor={t.id} className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-baseline gap-2 text-sm font-medium">
                      <span>{t.title}</span>
                      {hit && (
                        <span className="rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-400">
                          reached
                        </span>
                      )}
                    </span>
                    <span className="truncate text-xs font-normal text-muted-foreground">
                      Fires at{" "}
                      <span className="font-medium tabular-nums text-foreground">
                        {formatCurrency(thresholdAmount, 0)}
                      </span>{" "}
                      · {t.pct}% of budget
                    </span>
                  </Label>
                  <Switch
                    id={t.id}
                    checked={t.checked}
                    onCheckedChange={(checked) => handleUpdate({ [t.key]: checked })}
                  />
                </div>
              )
            })}
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Shield className="h-3.5 w-3.5 text-muted-foreground" />
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Automatic guardrails
            </h4>
          </div>
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-3">
              <Label htmlFor="degradation" className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium">Downgrade models at 80%</span>
                <span className="text-xs font-normal text-muted-foreground">
                  Kicks in at{" "}
                  <span className="font-medium tabular-nums text-foreground">
                    {formatCurrency(metrics.budgetAmount * 0.8, 0)}
                  </span>{" "}
                  · switches to cheaper models automatically
                </span>
              </Label>
              <Switch
                id="degradation"
                checked={budget?.degradationEnabled ?? true}
                onCheckedChange={(checked) => handleUpdate({ degradationEnabled: checked })}
              />
            </div>

            <div
              className={cn(
                "space-y-3 rounded-md border border-border/60 p-3",
                budget?.hardLimitEnabled && "border-red-500/30 bg-red-500/[0.03]"
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <Label htmlFor="hard-limit" className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium">Hard stop</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    Block non-essential AI features once usage crosses the limit below.
                  </span>
                </Label>
                <Switch
                  id="hard-limit"
                  checked={budget?.hardLimitEnabled ?? false}
                  onCheckedChange={(checked) => handleUpdate({ hardLimitEnabled: checked })}
                />
              </div>
              {budget?.hardLimitEnabled && (
                <div className="flex items-end justify-between gap-4 border-t border-border/60 pt-3">
                  <div className="space-y-1">
                    <Label
                      htmlFor="hard-limit-percent"
                      className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                    >
                      Cap at
                    </Label>
                    <div className="flex items-baseline gap-1">
                      <Input
                        id="hard-limit-percent"
                        type="number"
                        min="100"
                        max="500"
                        step="10"
                        value={localHardLimit}
                        onChange={(e) => onHardLimitChange(e.target.value)}
                        onBlur={onHardLimitCommit}
                        className="h-auto w-16 rounded-none border-0 border-b border-border bg-transparent px-0 text-lg font-semibold tabular-nums shadow-none focus-visible:border-primary focus-visible:ring-0"
                      />
                      <span className="text-lg text-muted-foreground">%</span>
                    </div>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <div>Blocks at</div>
                    <div className="font-semibold tabular-nums text-foreground">
                      {formatCurrency(metrics.budgetAmount * (parseInt(localHardLimit || "100", 10) / 100), 0)}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
