export const MS_PER_DAY = 86_400_000

export function formatCurrency(value: number, maxFractionDigits = 2) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Math.min(2, maxFractionDigits),
    maximumFractionDigits: maxFractionDigits,
  }).format(value)
}

export function formatShortDate(d: Date, timezone?: string) {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: timezone,
  })
}

export type Status = "on_track" | "at_risk" | "over"

export interface BudgetMetrics {
  status: Status
  statusCopy: string
  totalCost: number
  budgetAmount: number
  /** The limit the stop points are drawn from: the budget, or Threa's ceiling when that is lower. */
  enforcedLimit: number
  percentUsed: number
  projectedTotal: number
  projectedOverage: number
  dailyAvg: number
  daysElapsed: number
  daysTotal: number
  daysRemaining: number
  periodStart: Date
  periodEnd: Date
  budgetBustDate: Date | null
}

export function computeMetrics(opts: {
  totalCost: number
  budgetAmount: number
  /** Undefined only while the budget is still loading. */
  operatorCeilingUsd: number | undefined
  percentUsed: number
  periodStart: string
  periodEnd: string
}): BudgetMetrics {
  const periodStart = new Date(opts.periodStart)
  const periodEnd = new Date(opts.periodEnd)
  const now = new Date()

  const daysTotal = Math.max(1, Math.round((periodEnd.getTime() - periodStart.getTime()) / MS_PER_DAY))
  const daysElapsedRaw = (now.getTime() - periodStart.getTime()) / MS_PER_DAY
  const daysElapsed = Math.max(0.5, Math.min(daysTotal, daysElapsedRaw))
  const daysRemaining = Math.max(0, daysTotal - Math.floor(daysElapsed))

  const dailyAvg = opts.totalCost / daysElapsed
  const projectedTotal = dailyAvg * daysTotal
  const projectedOverage = Math.max(0, projectedTotal - opts.budgetAmount)
  const projectedPercent = opts.budgetAmount > 0 ? (projectedTotal / opts.budgetAmount) * 100 : 0

  let status: Status = "on_track"
  if (opts.percentUsed >= 100 || projectedPercent > 110) status = "over"
  else if (projectedPercent > 100) status = "at_risk"

  let budgetBustDate: Date | null = null
  if (dailyAvg > 0 && projectedTotal > opts.budgetAmount && opts.totalCost < opts.budgetAmount) {
    const daysUntilBust = opts.budgetAmount / dailyAvg
    if (daysUntilBust > daysElapsed && daysUntilBust <= daysTotal) {
      budgetBustDate = new Date(periodStart.getTime() + daysUntilBust * MS_PER_DAY)
    }
  }

  let statusCopy: string
  if (status === "on_track") {
    statusCopy =
      projectedTotal > 0
        ? `Expected to finish within budget at ${formatCurrency(projectedTotal)}.`
        : "No AI spend recorded yet this cycle."
  } else if (status === "at_risk") {
    statusCopy = `Expected to finish ${formatCurrency(projectedOverage)} over budget.`
  } else if (opts.percentUsed >= 100) {
    statusCopy = `Currently ${formatCurrency(opts.totalCost - opts.budgetAmount)} over budget.`
  } else {
    statusCopy = `Expected to finish ${formatCurrency(projectedOverage)} over budget.`
  }

  return {
    status,
    statusCopy,
    totalCost: opts.totalCost,
    budgetAmount: opts.budgetAmount,
    enforcedLimit: Math.min(opts.budgetAmount, opts.operatorCeilingUsd ?? opts.budgetAmount),
    percentUsed: opts.percentUsed,
    projectedTotal,
    projectedOverage,
    dailyAvg,
    daysElapsed,
    daysTotal,
    daysRemaining,
    periodStart,
    periodEnd,
    budgetBustDate,
  }
}

export const statusStyles: Record<Status, { dot: string; stroke: string }> = {
  on_track: { dot: "bg-emerald-500", stroke: "#059669" },
  at_risk: { dot: "bg-amber-500", stroke: "#d97706" },
  over: { dot: "bg-destructive", stroke: "#dc2626" },
}
