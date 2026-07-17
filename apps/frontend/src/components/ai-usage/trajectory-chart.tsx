import { useMemo, useState } from "react"
import { Area, AreaChart, CartesianGrid, ReferenceArea, ReferenceDot, ReferenceLine, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { cn } from "@/lib/utils"
import { formatCurrency, formatShortDate, MS_PER_DAY, statusStyles, type BudgetMetrics } from "./metrics"

type LegendKind = "line" | "line-dashed" | "line-muted" | "area"

function ChartLegendItem({
  id,
  label,
  color,
  kind,
  focused,
  onFocus,
}: {
  id: string
  label: string
  color: string
  kind: LegendKind
  focused: string | null
  onFocus: (id: string | null) => void
}) {
  const active = focused === null || focused === id
  return (
    <button
      type="button"
      className={cn(
        "group inline-flex items-center gap-1.5 rounded text-[11px] text-muted-foreground transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        !active && "opacity-40"
      )}
      onMouseEnter={() => onFocus(id)}
      onMouseLeave={() => onFocus(null)}
      onFocus={() => onFocus(id)}
      onBlur={() => onFocus(null)}
    >
      {kind === "area" && <span className="h-2.5 w-4 rounded-sm" style={{ background: color }} />}
      {kind === "line-dashed" && (
        <span
          className="h-[2px] w-4"
          style={{
            backgroundImage: `repeating-linear-gradient(to right, ${color} 0 4px, transparent 4px 8px)`,
          }}
        />
      )}
      {kind === "line-muted" && <span className="h-[2px] w-4 bg-foreground/50" />}
      {kind === "line" && <span className="h-[2px] w-4" style={{ background: color }} />}
      <span className="group-hover:text-foreground">{label}</span>
    </button>
  )
}

export function TrajectoryChart({ metrics, timezone }: { metrics: BudgetMetrics; timezone: string }) {
  const styles = statusStyles[metrics.status]
  const [focused, setFocused] = useState<string | null>(null)

  // Build the data series. Actual line runs [0, daysElapsed]; projected runs
  // [daysElapsed, daysTotal]. They share a transition point at today so the
  // two segments meet cleanly.
  const data = useMemo(() => {
    const rows: Array<{ day: number; actual: number | null; projected: number | null }> = []
    for (let d = 0; d <= metrics.daysTotal; d++) {
      rows.push({
        day: d,
        actual: d <= metrics.daysElapsed ? metrics.dailyAvg * d : null,
        projected: d >= metrics.daysElapsed ? metrics.dailyAvg * d : null,
      })
    }
    const fractional =
      metrics.daysElapsed !== Math.floor(metrics.daysElapsed) &&
      metrics.daysElapsed > 0 &&
      metrics.daysElapsed < metrics.daysTotal
    if (fractional) {
      rows.push({
        day: metrics.daysElapsed,
        actual: metrics.totalCost,
        projected: metrics.totalCost,
      })
      rows.sort((a, b) => a.day - b.day)
    }
    return rows
  }, [metrics.daysTotal, metrics.daysElapsed, metrics.dailyAvg, metrics.totalCost])

  const maxY = Math.max(metrics.budgetAmount * 1.25, metrics.projectedTotal * 1.12, metrics.hardLimitAmount ?? 0, 0.01)

  const config = useMemo<ChartConfig>(
    () => ({
      actual: { label: "Actual", color: styles.stroke },
      projected: { label: "Projected", color: styles.stroke },
    }),
    [styles.stroke]
  )

  const dayToDate = (day: number) => new Date(metrics.periodStart.getTime() + day * MS_PER_DAY)

  const dim = (key: string) => (focused !== null && focused !== key ? 0.2 : 1)

  const xTicks = [0, metrics.daysElapsed, metrics.daysTotal]

  return (
    <div className="space-y-3">
      {/* Interactive legend */}
      <div className="flex flex-wrap items-center justify-end gap-4">
        <ChartLegendItem
          id="actual"
          label="Actual"
          color={styles.stroke}
          kind="line"
          focused={focused}
          onFocus={setFocused}
        />
        <ChartLegendItem
          id="projected"
          label="Projected"
          color={styles.stroke}
          kind="line-dashed"
          focused={focused}
          onFocus={setFocused}
        />
        <ChartLegendItem
          id="budget"
          label="Budget"
          color="currentColor"
          kind="line-muted"
          focused={focused}
          onFocus={setFocused}
        />
        <ChartLegendItem
          id="overBudget"
          label="Over budget"
          color="rgba(217, 119, 6, 0.35)"
          kind="area"
          focused={focused}
          onFocus={setFocused}
        />
        {metrics.hardLimitAmount !== null && (
          <ChartLegendItem
            id="hardLimit"
            label="Hard limit"
            color="rgba(220, 38, 38, 0.45)"
            kind="area"
            focused={focused}
            onFocus={setFocused}
          />
        )}
      </div>

      <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
        <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
          <defs>
            <linearGradient id="actualFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={styles.stroke} stopOpacity={0.28} />
              <stop offset="100%" stopColor={styles.stroke} stopOpacity={0.02} />
            </linearGradient>
          </defs>

          <CartesianGrid vertical={false} strokeDasharray="2 3" strokeOpacity={0.15} />

          <XAxis
            dataKey="day"
            type="number"
            domain={[0, metrics.daysTotal]}
            ticks={xTicks}
            tickFormatter={(day: number) => {
              if (Math.abs(day - metrics.daysElapsed) < 0.01) return "Today"
              return formatShortDate(dayToDate(day), timezone)
            }}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 10 }}
            interval={0}
            minTickGap={0}
          />

          <YAxis
            type="number"
            domain={[0, maxY]}
            tickFormatter={(v: number) => formatCurrency(v, 0)}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 10 }}
            width={56}
          />

          {/* Over-budget zone */}
          <ReferenceArea
            y1={metrics.budgetAmount}
            y2={metrics.hardLimitAmount !== null ? metrics.hardLimitAmount : maxY}
            fill="#d97706"
            fillOpacity={0.09 * dim("overBudget")}
            stroke="none"
            ifOverflow="visible"
          />

          {/* Above-hard-limit zone */}
          {metrics.hardLimitAmount !== null && (
            <ReferenceArea
              y1={metrics.hardLimitAmount}
              y2={maxY}
              fill="#dc2626"
              fillOpacity={0.11 * dim("hardLimit")}
              stroke="none"
              ifOverflow="visible"
            />
          )}

          {/* Budget reference line */}
          <ReferenceLine
            y={metrics.budgetAmount}
            stroke="currentColor"
            strokeOpacity={0.5 * dim("budget")}
            strokeWidth={1}
          />

          {/* Hard limit reference line */}
          {metrics.hardLimitAmount !== null && (
            <ReferenceLine
              y={metrics.hardLimitAmount}
              stroke="#dc2626"
              strokeOpacity={0.55 * dim("hardLimit")}
              strokeWidth={1}
              strokeDasharray="2 3"
            />
          )}

          {/* Today vertical marker */}
          <ReferenceLine x={metrics.daysElapsed} stroke="currentColor" strokeOpacity={0.3} strokeDasharray="1 3" />

          {/* Actual (area with fill) */}
          <Area
            type="monotone"
            dataKey="actual"
            stroke={styles.stroke}
            strokeWidth={2.25}
            strokeOpacity={dim("actual")}
            fill="url(#actualFill)"
            fillOpacity={dim("actual")}
            connectNulls={false}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--background))", fill: styles.stroke }}
            isAnimationActive={false}
          />

          {/* Projected (dashed, no fill) */}
          <Area
            type="monotone"
            dataKey="projected"
            stroke={styles.stroke}
            strokeWidth={2}
            strokeOpacity={0.85 * dim("projected")}
            strokeDasharray="5 4"
            fill="none"
            connectNulls={false}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--background))", fill: styles.stroke }}
            isAnimationActive={false}
          />

          {/* Today anchor dot */}
          <ReferenceDot
            x={metrics.daysElapsed}
            y={metrics.totalCost}
            r={4.5}
            fill={styles.stroke}
            stroke="hsl(var(--background))"
            strokeWidth={2}
            ifOverflow="visible"
          />

          <ChartTooltip
            cursor={{ stroke: "currentColor", strokeOpacity: 0.4, strokeDasharray: "2 2" }}
            content={
              <ChartTooltipContent
                indicator="dot"
                labelFormatter={(_label, payload) => {
                  const day = payload?.[0]?.payload?.day
                  if (typeof day !== "number") return ""
                  const date = dayToDate(day)
                  const dayNum = Math.max(1, Math.ceil(day))
                  return (
                    <span className="flex items-baseline gap-2">
                      <span>{formatShortDate(date, timezone)}</span>
                      <span className="text-[10px] text-muted-foreground">
                        day {dayNum} of {metrics.daysTotal}
                      </span>
                    </span>
                  )
                }}
                formatter={(value, name, item) => {
                  const num = typeof value === "number" ? value : 0
                  const color = item.color
                  const displayName = name === "actual" ? "Actual" : "Projected"
                  return (
                    <>
                      <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: color }} />
                      <div className="flex flex-1 items-center justify-between gap-4 leading-none">
                        <span className="text-muted-foreground">{displayName}</span>
                        <span className="font-medium tabular-nums text-foreground">{formatCurrency(num)}</span>
                      </div>
                    </>
                  )
                }}
              />
            }
          />
        </AreaChart>
      </ChartContainer>
    </div>
  )
}
