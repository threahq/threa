import { useMemo, useState } from "react"
import { ChevronRight, Layers } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { AI_USAGE_CATEGORIES, type AIUsageByFunction, type AIUsageByModel, type AIUsageCategory } from "@threa/types"
import { categoryColor, categoryMeta } from "./category-meta"
import { formatCurrency } from "./metrics"
import { SectionLabel } from "./primitives"

interface CategoryGroup {
  category: AIUsageCategory
  cost: number
  calls: number
  pct: number
  functions: AIUsageByFunction[]
}

/**
 * Share of prompt tokens the provider served from its cache. Rendered only
 * above zero: a fresh column of "0%" on every row would read as a fault rather
 * than as "this component has no cacheable prefix", which is the common and
 * unremarkable case.
 */
function cacheHitPct(promptTokens: number, cachedPromptTokens: number): number | null {
  if (promptTokens <= 0 || cachedPromptTokens <= 0) return null
  return (cachedPromptTokens / promptTokens) * 100
}

/**
 * A non-zero share must never render as "0% cached" — that reads as "caching is
 * broken" when it means "caching started partway through the billing period".
 * The window is month-to-date, so the first cached call after a prompt is made
 * cacheable lands against a denominator of everything billed at full price
 * before it: one 2,816-token hit against boundary extraction's ~4M tokens for
 * the month is 0.07%, which rounds to zero and inverts the signal.
 */
function formatCacheHit(pct: number): string {
  if (pct < 1) return "<1% cached"
  return `${pct.toFixed(0)}% cached`
}

function CacheHitLabel({ promptTokens, cachedPromptTokens }: { promptTokens: number; cachedPromptTokens: number }) {
  const pct = cacheHitPct(promptTokens, cachedPromptTokens)
  // Fixed width whether or not the label renders, so expanding a category can't
  // shift the columns beside it (INV-21).
  return (
    <span className="w-16 text-right text-[11px] tabular-nums text-muted-foreground">
      {pct === null ? "" : formatCacheHit(pct)}
    </span>
  )
}

function CategoryRow({
  group,
  isExpanded,
  onToggle,
}: {
  group: CategoryGroup
  isExpanded: boolean
  onToggle: () => void
}) {
  const meta = categoryMeta[group.category]
  const Icon = meta.icon
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        className="flex w-full items-baseline gap-2 rounded-sm py-1 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 flex-none translate-y-[2px] text-muted-foreground/70 transition-transform",
            isExpanded && "rotate-90"
          )}
        />
        <span
          className="h-2 w-2 flex-none translate-y-[5px] rounded-sm"
          style={{ background: categoryColor[group.category] }}
          aria-hidden
        />
        <Icon className="h-3.5 w-3.5 flex-none translate-y-[3px] text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium">{meta.label}</span>
        <span className="tabular-nums">{formatCurrency(group.cost)}</span>
        <span className="w-9 text-right text-[11px] tabular-nums text-muted-foreground">{group.pct.toFixed(0)}%</span>
        <span className="w-16 text-right text-[11px] tabular-nums text-muted-foreground">
          {group.calls.toLocaleString()} calls
        </span>
      </button>
      {isExpanded && (
        <ul className="mb-1 ml-[1.375rem] space-y-1 border-l border-border/60 pl-3">
          {group.functions.map((fn) => (
            <li key={fn.functionId} className="flex items-baseline gap-2 text-[11px]">
              <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{fn.functionId}</span>
              <span className="tabular-nums text-foreground">{formatCurrency(fn.totalCostUsd)}</span>
              <CacheHitLabel promptTokens={fn.promptTokens} cachedPromptTokens={fn.cachedPromptTokens} />
              <span className="w-16 text-right tabular-nums text-muted-foreground">
                {fn.recordCount.toLocaleString()} calls
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

export function CapabilityBreakdown({
  byFunction,
  byModel,
  totalCost,
  isLoading,
}: {
  byFunction: AIUsageByFunction[]
  byModel: AIUsageByModel[]
  totalCost: number
  isLoading: boolean
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const groups = useMemo<CategoryGroup[]>(() => {
    const map = new Map<AIUsageCategory, AIUsageByFunction[]>()
    for (const fn of byFunction) {
      const list = map.get(fn.category) ?? []
      list.push(fn)
      map.set(fn.category, list)
    }
    const result: CategoryGroup[] = []
    for (const category of AI_USAGE_CATEGORIES) {
      const functions = map.get(category)
      if (!functions || functions.length === 0) continue
      const cost = functions.reduce((sum, f) => sum + f.totalCostUsd, 0)
      const calls = functions.reduce((sum, f) => sum + f.recordCount, 0)
      result.push({
        category,
        cost,
        calls,
        pct: totalCost > 0 ? (cost / totalCost) * 100 : 0,
        functions: [...functions].sort((a, b) => b.totalCostUsd - a.totalCostUsd),
      })
    }
    return result.sort((a, b) => b.cost - a.cost)
  }, [byFunction, totalCost])

  const topModels = useMemo(() => [...byModel].sort((a, b) => b.totalCostUsd - a.totalCostUsd).slice(0, 5), [byModel])

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">Where the cost comes from</CardTitle>
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
        <SectionLabel>By capability</SectionLabel>
        <CardTitle className="text-base font-medium">Where the cost comes from</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {groups.length === 0 ? (
          <div className="flex h-[200px] flex-col items-center justify-center gap-1 text-center">
            <Layers className="h-6 w-6 text-muted-foreground/60" />
            <div className="text-sm text-muted-foreground">No AI usage recorded yet this cycle</div>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex h-3 overflow-hidden rounded-full bg-muted">
                {groups.map((group) => (
                  <div
                    key={group.category}
                    className="h-full first:rounded-l-full last:rounded-r-full"
                    style={{ width: `${group.pct}%`, background: categoryColor[group.category] }}
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                {groups.map((group) => (
                  <span key={group.category} className="inline-flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 rounded-sm"
                      style={{ background: categoryColor[group.category] }}
                      aria-hidden
                    />
                    {categoryMeta[group.category].label}
                  </span>
                ))}
              </div>
            </div>

            <ul className="space-y-0.5">
              {groups.map((group) => (
                <CategoryRow
                  key={group.category}
                  group={group}
                  isExpanded={expanded[group.category] ?? false}
                  onToggle={() =>
                    setExpanded((prev) => ({ ...prev, [group.category]: !(prev[group.category] ?? false) }))
                  }
                />
              ))}
            </ul>

            {topModels.length > 0 && (
              <div className="space-y-2 border-t border-border/60 pt-4">
                <SectionLabel>By model</SectionLabel>
                <ul className="space-y-1.5">
                  {topModels.map((model) => (
                    <li key={model.model} className="flex items-baseline gap-2 text-sm">
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                        {model.model}
                      </span>
                      <span className="tabular-nums">{formatCurrency(model.totalCostUsd)}</span>
                      <CacheHitLabel promptTokens={model.promptTokens} cachedPromptTokens={model.cachedPromptTokens} />
                      <span className="w-24 text-right text-[11px] tabular-nums text-muted-foreground">
                        {model.totalTokens.toLocaleString()} tok
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
