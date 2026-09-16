import { useCallback, useEffect, useState } from "react"
import { Bell, Power } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { useUpdateAIBudget } from "@/hooks"
import { AI_SPEND_STAGE_CUTOFFS, type AIBudgetConfig, type UpdateAIBudgetInput } from "@threahq/types"
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
  isLoading,
}: {
  workspaceId: string
  budget: AIBudgetConfig | null
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
  isLoading: boolean
}) {
  const updateBudget = useUpdateAIBudget(workspaceId, reportingTimezone)
  const serverAllowance = budget?.defaultUserAgentAllowanceUsd ?? null
  const [allowanceDraft, setAllowanceDraft] = useState(serverAllowance === null ? "" : String(serverAllowance))

  useEffect(() => {
    setAllowanceDraft(serverAllowance === null ? "" : String(serverAllowance))
  }, [serverAllowance])

  const handleUpdate = useCallback(
    (updates: UpdateAIBudgetInput) => {
      updateBudget.mutate(updates)
    },
    [updateBudget]
  )

  const commitAllowance = () => {
    const trimmed = allowanceDraft.trim()
    if (trimmed === "") {
      if (serverAllowance !== null) handleUpdate({ defaultUserAgentAllowanceUsd: null })
      return
    }
    const value = parseFloat(trimmed)
    if (isNaN(value) || value < 0) {
      setAllowanceDraft(serverAllowance === null ? "" : String(serverAllowance))
      return
    }
    if (value !== serverAllowance) handleUpdate({ defaultUserAgentAllowanceUsd: value })
  }

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
            Hard monthly limit · resets {resetDateStr} · currently {formatCurrency(metrics.totalCost)} of{" "}
            {formatCurrency(metrics.budgetAmount, 0)} used
          </p>
          {budget && budget.operatorCeilingUsd < metrics.budgetAmount && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Threa caps this workspace at {formatCurrency(budget.operatorCeilingUsd, 0)}, so the stop points use that
              amount.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Agents stop at {formatCurrency(metrics.enforcedLimit * AI_SPEND_STAGE_CUTOFFS.agents, 0)}, background AI
            winds down after that, and everything stops at {formatCurrency(metrics.enforcedLimit, 0)}.
          </p>
        </div>

        <div className="space-y-2">
          {budget?.operatorAiDisabled && (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
              Threa has turned AI off for this workspace.
            </p>
          )}
          <div
            className={cn(
              "flex items-center justify-between gap-3 rounded-md border border-border/60 p-3 transition-colors",
              budget?.aiDisabled && "border-destructive/40 bg-destructive/5"
            )}
          >
            <Label htmlFor="ai-disabled" className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-2 text-sm font-medium">
                <Power className="h-3.5 w-3.5 text-muted-foreground" />
                Turn off AI
              </span>
              <span className="text-xs font-normal text-muted-foreground">
                {budget?.aiDisabled
                  ? "All AI in this workspace is stopped."
                  : "Stops every AI feature for everyone in the workspace."}
              </span>
            </Label>
            <Switch
              id="ai-disabled"
              checked={budget?.aiDisabled ?? false}
              onCheckedChange={(checked) => handleUpdate({ aiDisabled: checked })}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label
            htmlFor="default-agent-allowance"
            className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Default agent allowance per person
          </Label>
          <div className="flex items-baseline gap-1 border-b border-border pb-1 focus-within:border-primary">
            <span className="text-sm font-semibold tabular-nums text-muted-foreground">$</span>
            <Input
              id="default-agent-allowance"
              type="number"
              min="0"
              step="1"
              inputMode="decimal"
              placeholder="No default"
              value={allowanceDraft}
              onChange={(e) => setAllowanceDraft(e.target.value)}
              onBlur={commitAllowance}
              className="h-auto w-full rounded-none border-0 bg-transparent px-0 text-base font-semibold tabular-nums shadow-none focus-visible:ring-0"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Monthly agent spend for anyone without their own allowance. Leave empty for no default.
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
      </CardContent>
    </Card>
  )
}
