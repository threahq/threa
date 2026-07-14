import { useMemo } from "react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { CalendarRange } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import { AI_USAGE_CATEGORIES, type AIUsageByDay } from "@threa/types"
import { categoryColor, categoryMeta } from "./category-meta"
import { formatCurrency, formatShortDate, MS_PER_DAY } from "./metrics"
import { SectionLabel } from "./primitives"

type DailyDatum = { date: string } & Record<string, string | number>

function utcMidnight(iso: string) {
  const d = new Date(iso)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

export function buildDailySpendData(byDay: AIUsageByDay[], periodStart: string, periodEnd: string): DailyDatum[] {
  const start = utcMidnight(periodStart)
  // periodEnd is exclusive; include a final partial day but not a day starting exactly at the boundary.
  const end = Date.parse(periodEnd)
  const rows = new Map<string, DailyDatum>()
  for (let ms = start; ms < end; ms += MS_PER_DAY) {
    const date = new Date(ms).toISOString().slice(0, 10)
    const datum: DailyDatum = { date }
    for (const category of AI_USAGE_CATEGORIES) datum[category] = 0
    rows.set(date, datum)
  }
  for (const row of byDay) {
    const datum = rows.get(row.date)
    if (datum) datum[row.category] = (datum[row.category] as number) + row.totalCostUsd
  }
  return [...rows.values()]
}

export function DailySpendChart({
  byDay,
  periodStart,
  periodEnd,
  isLoading,
}: {
  byDay: AIUsageByDay[]
  periodStart: string
  periodEnd: string
  isLoading: boolean
}) {
  const data = useMemo(() => buildDailySpendData(byDay, periodStart, periodEnd), [byDay, periodStart, periodEnd])

  const config = useMemo<ChartConfig>(() => {
    const c: ChartConfig = {}
    for (const category of AI_USAGE_CATEGORIES) {
      c[category] = { label: categoryMeta[category].label, color: categoryColor[category] }
    }
    return c
  }, [])

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">Daily spend</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[260px] w-full" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <SectionLabel>Per day</SectionLabel>
        <CardTitle className="text-base font-medium">Daily spend</CardTitle>
      </CardHeader>
      <CardContent>
        {byDay.length === 0 ? (
          <div className="flex h-[200px] flex-col items-center justify-center gap-1 text-center">
            <CalendarRange className="h-6 w-6 text-muted-foreground/60" />
            <div className="text-sm text-muted-foreground">No AI usage recorded yet this cycle</div>
          </div>
        ) : (
          <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
            <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray="2 3" strokeOpacity={0.15} />
              <XAxis
                dataKey="date"
                tickFormatter={(value: string) => String(Number(value.slice(8, 10)))}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10 }}
                minTickGap={8}
              />
              <YAxis
                tickFormatter={(v: number) => formatCurrency(v, 0)}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10 }}
                width={56}
              />
              {AI_USAGE_CATEGORIES.map((category) => (
                <Bar
                  key={category}
                  dataKey={category}
                  stackId="cost"
                  fill={categoryColor[category]}
                  isAnimationActive={false}
                />
              ))}
              <ChartTooltip
                cursor={{ fill: "currentColor", fillOpacity: 0.06 }}
                content={
                  <ChartTooltipContent
                    labelFormatter={(_label, payload) => {
                      const date = payload?.[0]?.payload?.date
                      if (typeof date !== "string") return ""
                      return formatShortDate(new Date(`${date}T00:00:00.000Z`), "UTC")
                    }}
                    formatter={(value, name, item) => {
                      const num = typeof value === "number" ? value : 0
                      if (num <= 0) return null
                      const category = name as (typeof AI_USAGE_CATEGORIES)[number]
                      return (
                        <>
                          <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: item.color }} />
                          <div className="flex flex-1 items-center justify-between gap-4 leading-none">
                            <span className="text-muted-foreground">{categoryMeta[category].label}</span>
                            <span className="font-medium tabular-nums text-foreground">{formatCurrency(num)}</span>
                          </div>
                        </>
                      )
                    }}
                  />
                }
              />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
