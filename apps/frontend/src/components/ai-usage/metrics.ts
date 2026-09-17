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
  /** The limit spend is enforced against: the budget, or Threa's ceiling when that is lower. */
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
  aiDisabled: boolean
  operatorAiDisabled: boolean
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

  const enforcedLimit = Math.min(opts.budgetAmount, opts.operatorCeilingUsd ?? opts.budgetAmount)
  // The gate denies everything at a $0 limit, so it reads as fully used.
  const percentUsed = enforcedLimit > 0 ? (opts.totalCost / enforcedLimit) * 100 : 100
  const dailyAvg = opts.totalCost / daysElapsed
  const projectedTotal = dailyAvg * daysTotal
  const projectedOverage = Math.max(0, projectedTotal - enforcedLimit)
  const projectedPercent = enforcedLimit > 0 ? (projectedTotal / enforcedLimit) * 100 : 0

  const aiOff = opts.aiDisabled || opts.operatorAiDisabled
  let status: Status = "on_track"
  if (aiOff || percentUsed >= 100 || projectedPercent > 110) status = "over"
  else if (projectedPercent > 100) status = "at_risk"

  let budgetBustDate: Date | null = null
  if (dailyAvg > 0 && projectedTotal > enforcedLimit && opts.totalCost < enforcedLimit) {
    const daysUntilBust = enforcedLimit / dailyAvg
    if (daysUntilBust > daysElapsed && daysUntilBust <= daysTotal) {
      budgetBustDate = new Date(periodStart.getTime() + daysUntilBust * MS_PER_DAY)
    }
  }

  let statusCopy: string
  if (opts.operatorAiDisabled) {
    statusCopy = "Threa has turned AI off for this workspace."
  } else if (opts.aiDisabled) {
    statusCopy = "AI is turned off for this workspace."
  } else if (enforcedLimit <= 0) {
    statusCopy = "The limit is $0, so AI is off."
  } else if (status === "on_track") {
    statusCopy =
      projectedTotal > 0
        ? `Expected to finish within the limit at ${formatCurrency(projectedTotal)}.`
        : "No AI spend recorded yet this cycle."
  } else if (status === "at_risk") {
    statusCopy = `Expected to reach the limit before the cycle ends.`
  } else if (percentUsed >= 100) {
    statusCopy = `Limit reached. AI is off until the cycle resets.`
  } else {
    statusCopy = `Expected to reach the limit before the cycle ends.`
  }

  return {
    status,
    statusCopy,
    totalCost: opts.totalCost,
    budgetAmount: opts.budgetAmount,
    enforcedLimit,
    percentUsed,
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
