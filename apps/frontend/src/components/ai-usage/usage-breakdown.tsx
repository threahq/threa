import { useMemo } from "react"
import { Bot, Cog } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import type { AIUsageByUser } from "@threahq/types"
import { formatCurrency } from "./metrics"
import { SectionLabel } from "./primitives"

export function UsageSplitCard({
  systemCost,
  assistantCost,
  totalCost,
  isLoading,
}: {
  systemCost: number
  assistantCost: number
  totalCost: number
  isLoading: boolean
}) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">Where the spend is going</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[120px] w-full" />
        </CardContent>
      </Card>
    )
  }

  const systemPct = totalCost > 0 ? (systemCost / totalCost) * 100 : 0
  const assistantPct = totalCost > 0 ? (assistantCost / totalCost) * 100 : 0

  return (
    <Card>
      <CardHeader className="pb-3">
        <SectionLabel>Split by source</SectionLabel>
        <CardTitle className="text-base font-medium">Where the spend is going</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Stacked composition bar */}
        <div className="space-y-2">
          <div className="relative h-3 overflow-hidden rounded-full bg-muted">
            <div
              className="absolute inset-y-0 left-0 bg-primary transition-all"
              style={{ width: `${assistantPct}%` }}
            />
            <div
              className="absolute inset-y-0 bg-foreground/60 transition-all"
              style={{ left: `${assistantPct}%`, width: `${systemPct}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm bg-primary" />
              Assistant
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm bg-foreground/60" />
              System
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5 rounded-md border border-border/60 p-3">
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Bot className="h-3.5 w-3.5" />
              Assistant
            </div>
            <div className="text-xl font-semibold tabular-nums">{formatCurrency(assistantCost)}</div>
            <div className="text-[11px] text-muted-foreground">{assistantPct.toFixed(1)}% · companion responses</div>
          </div>
          <div className="space-y-1.5 rounded-md border border-border/60 p-3">
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Cog className="h-3.5 w-3.5" />
              System
            </div>
            <div className="text-xl font-semibold tabular-nums">{formatCurrency(systemCost)}</div>
            <div className="text-[11px] text-muted-foreground">{systemPct.toFixed(1)}% • background jobs</div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export function TopSpendersCard({
  byUser,
  userNames,
  assistantTotal,
  isLoading,
}: {
  byUser: AIUsageByUser[]
  userNames: Map<string, string>
  assistantTotal: number
  isLoading: boolean
}) {
  const items = useMemo(() => {
    const userUsage = byUser.filter((u) => u.userId !== null)
    const sorted = [...userUsage].sort((a, b) => b.totalCostUsd - a.totalCostUsd)
    const maxCost = Math.max(...sorted.map((u) => u.totalCostUsd), 0.0001)
    return sorted.map((u) => ({
      userId: u.userId!,
      name: userNames.get(u.userId!) ?? "Unknown user",
      cost: u.totalCostUsd,
      tokens: u.totalTokens,
      percentOfAssistant: assistantTotal > 0 ? (u.totalCostUsd / assistantTotal) * 100 : 0,
      barPct: (u.totalCostUsd / maxCost) * 100,
    }))
  }, [byUser, userNames, assistantTotal])

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">Top assistant users</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[280px] w-full" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <SectionLabel>Top spenders</SectionLabel>
        <CardTitle className="text-base font-medium">Assistant usage by member</CardTitle>
        <CardDescription className="text-xs">
          {items.length} {items.length === 1 ? "member" : "members"} active this cycle
        </CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <div className="flex h-[200px] flex-col items-center justify-center gap-1 text-center">
            <Bot className="h-6 w-6 text-muted-foreground/60" />
            <div className="text-sm text-muted-foreground">No assistant usage yet this cycle</div>
          </div>
        ) : (
          <ScrollArea className="h-[280px]">
            <ul className="space-y-3 pr-3">
              {items.map((item, idx) => (
                <li key={item.userId} className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="w-5 text-[11px] tabular-nums text-muted-foreground">{idx + 1}</span>
                      <span className="truncate font-medium">{item.name}</span>
                    </div>
                    <div className="flex items-baseline gap-2 tabular-nums">
                      <span>{formatCurrency(item.cost)}</span>
                      <span className="w-9 text-right text-[11px] text-muted-foreground">
                        {item.percentOfAssistant.toFixed(0)}%
                      </span>
                    </div>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${Math.min(item.barPct, 100)}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}
