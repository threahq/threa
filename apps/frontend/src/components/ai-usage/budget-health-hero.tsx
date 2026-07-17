import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { formatCurrency, formatShortDate, statusStyles, type BudgetMetrics } from "./metrics"
import { Stat } from "./primitives"
import { TrajectoryChart } from "./trajectory-chart"

export function BudgetHealthHero({
  metrics,
  timezone,
  isLoading,
}: {
  metrics: BudgetMetrics
  /**
   * The zone the cycle window was drawn in. These dates are the boundaries of
   * that window, not wall-clock events, so they render in the zone the viewer
   * chose to report in — device-local (INV-42) would label a workspace-timezone
   * cycle with the neighbouring day.
   */
  timezone: string
  isLoading: boolean
}) {
  const styles = statusStyles[metrics.status]

  if (isLoading) {
    return (
      <Card className="overflow-hidden">
        <CardContent className="space-y-6 p-6">
          <Skeleton className="h-5 w-64" />
          <div className="grid gap-6 sm:grid-cols-4">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
          <Skeleton className="h-[220px] w-full" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <div className="space-y-6 p-6 sm:p-8">
        <div className="space-y-1">
          <div className="flex items-baseline gap-2">
            <span className={cn("h-1.5 w-1.5 flex-none translate-y-[-3px] rounded-full", styles.dot)} aria-hidden />
            <p className="text-lg leading-snug sm:text-xl">{metrics.statusCopy}</p>
          </div>
          <p className="text-sm text-muted-foreground">
            Cycle {formatShortDate(metrics.periodStart, timezone)} – {formatShortDate(metrics.periodEnd, timezone)} ·{" "}
            {metrics.daysRemaining} days remaining
          </p>
        </div>

        <div className="grid gap-6 border-y border-border/60 py-5 sm:grid-cols-4">
          <Stat
            label="Spent"
            value={formatCurrency(metrics.totalCost)}
            hint={`${metrics.percentUsed.toFixed(0)}% of ${formatCurrency(metrics.budgetAmount, 0)} budget`}
          />
          <Stat
            label="Projected"
            value={formatCurrency(metrics.projectedTotal)}
            hint={
              metrics.projectedOverage > 0
                ? `${formatCurrency(metrics.projectedOverage)} over budget`
                : `${formatCurrency(Math.max(0, metrics.budgetAmount - metrics.projectedTotal))} headroom`
            }
            info={
              <>
                <p className="font-medium">Rough projection</p>
                <p className="mt-1 text-muted-foreground">
                  Straight-line extrapolation: total spend ÷ days elapsed × days in cycle.
                </p>
                <p className="mt-1 text-muted-foreground">
                  Doesn't model weekends, peaks, or behaviour changes — treat it as a ballpark, not a forecast.
                </p>
              </>
            }
          />
          <Stat
            label="Daily avg"
            value={formatCurrency(metrics.dailyAvg, 4)}
            hint={`over ${metrics.daysElapsed.toFixed(1)} days`}
          />
          <Stat
            label="Days remaining"
            value={<span className="tabular-nums">{metrics.daysRemaining}</span>}
            hint={
              metrics.budgetBustDate
                ? `Budget exhausts ≈ ${formatShortDate(metrics.budgetBustDate, timezone)}`
                : `of ${metrics.daysTotal} day cycle`
            }
          />
        </div>

        <TrajectoryChart metrics={metrics} timezone={timezone} />
      </div>
    </Card>
  )
}
