import { useMemo, useState } from "react"
import { Bot, Cog, SlidersHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SearchableSelect } from "@/components/ui/searchable-select"
import { Skeleton } from "@/components/ui/skeleton"
import type { AIUsageByUser, AIUserLimits } from "@threahq/types"
import { formatCurrency } from "./metrics"
import { SectionLabel } from "./primitives"
import { UserLimitsDialog } from "./user-limits-dialog"

function describeUserLimits(limits: AIUserLimits): string[] {
  if (limits.aiDisabled) return ["AI off"]
  const parts: string[] = []
  if (limits.monthlyQuotaUsd !== null) parts.push(`Max ${formatCurrency(limits.monthlyQuotaUsd, 0)}`)
  if (limits.agentAllowanceUsd !== null) parts.push(`Agents ${formatCurrency(limits.agentAllowanceUsd, 0)}`)
  return parts
}

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
  workspaceId,
  byUser,
  userNames,
  userLimits,
  assistantTotal,
  isLoading,
}: {
  workspaceId: string
  byUser: AIUsageByUser[]
  userNames: Map<string, string>
  userLimits: AIUserLimits[]
  assistantTotal: number
  isLoading: boolean
}) {
  const [editingUserId, setEditingUserId] = useState<string | null>(null)
  const limitsByUser = useMemo(() => new Map(userLimits.map((l) => [l.userId, l])), [userLimits])

  const activeCount = useMemo(() => byUser.filter((u) => u.userId !== null).length, [byUser])

  const items = useMemo(() => {
    const costByUser = new Map<string, number>()
    for (const u of byUser) {
      if (u.userId !== null) costByUser.set(u.userId, u.totalCostUsd)
    }
    // People with limits stay listed even before they spend this cycle, so their limits remain editable.
    for (const l of userLimits) {
      if (!costByUser.has(l.userId)) costByUser.set(l.userId, 0)
    }
    const sorted = [...costByUser].sort((a, b) => b[1] - a[1])
    const maxCost = Math.max(...sorted.map(([, cost]) => cost), 0.0001)
    return sorted.map(([userId, cost]) => ({
      userId,
      name: userNames.get(userId) ?? "Unknown user",
      cost,
      percentOfAssistant: assistantTotal > 0 ? (cost / assistantTotal) * 100 : 0,
      barPct: (cost / maxCost) * 100,
    }))
  }, [byUser, userLimits, userNames, assistantTotal])

  const unlistedMembers = useMemo(() => {
    const listed = new Set(items.map((item) => item.userId))
    return [...userNames]
      .filter(([userId]) => !listed.has(userId))
      .map(([userId, name]) => ({ userId, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [items, userNames])

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
          {activeCount} {activeCount === 1 ? "member" : "members"} active this cycle
        </CardDescription>
        {unlistedMembers.length > 0 && (
          <SearchableSelect
            items={unlistedMembers}
            value={null}
            onChange={(member) => setEditingUserId(member.userId)}
            getKey={(member) => member.userId}
            getKeywords={(member) => [member.name]}
            renderItem={(member) => <span className="truncate">{member.name}</span>}
            placeholder="Set limits for another member"
            searchPlaceholder="Search members"
            emptyMessage="No members found."
            triggerIcon={SlidersHorizontal}
            className="mt-2 h-8 w-full text-xs"
          />
        )}
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
              {items.map((item, idx) => {
                const limits = limitsByUser.get(item.userId)
                const limitParts = limits ? describeUserLimits(limits) : []
                return (
                  <li key={item.userId} className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="w-5 shrink-0 text-[11px] tabular-nums text-muted-foreground">{idx + 1}</span>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium">{item.name}</span>
                          {limitParts.length > 0 && (
                            <span className="truncate text-[11px] text-muted-foreground">{limitParts.join(" · ")}</span>
                          )}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1 tabular-nums">
                        <span>{formatCurrency(item.cost)}</span>
                        <span className="w-9 text-right text-[11px] text-muted-foreground">
                          {item.percentOfAssistant.toFixed(0)}%
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label={`Edit AI limits for ${item.name}`}
                          onClick={() => setEditingUserId(item.userId)}
                        >
                          <SlidersHorizontal className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{ width: `${Math.min(item.barPct, 100)}%` }}
                      />
                    </div>
                  </li>
                )
              })}
            </ul>
          </ScrollArea>
        )}
      </CardContent>
      {editingUserId && (
        <UserLimitsDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditingUserId(null)
          }}
          workspaceId={workspaceId}
          userId={editingUserId}
          userName={userNames.get(editingUserId) ?? "Unknown user"}
          limits={limitsByUser.get(editingUserId) ?? null}
        />
      )}
    </Card>
  )
}
