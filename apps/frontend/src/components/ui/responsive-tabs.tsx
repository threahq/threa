import type { ReactNode } from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select"
import { TabsList, TabsTrigger } from "./tabs"

interface ResponsiveTabsProps<T extends string> {
  tabs: readonly T[]
  labels: Record<T, string>
  value: T
  onValueChange: (value: T) => void
  /** Names the phone dropdown, which has no visible label of its own. */
  "aria-label": string
  /** Number of columns for the desktop grid (defaults to tabs.length). Ignored when children is provided. */
  columns?: number
  /** Custom desktop content. When provided, replaces the default TabsList grid on screens >= sm. */
  children?: ReactNode
}

/**
 * Mobile: Shadcn Select dropdown. Desktop: TabsList grid (or custom children).
 * When used with a Radix Tabs root, omit `children` to get the default TabsList.
 * When the desktop UI differs (e.g. pill buttons), pass custom `children`.
 */
export function ResponsiveTabs<T extends string>({
  tabs,
  labels,
  value,
  onValueChange,
  "aria-label": ariaLabel,
  columns,
  children,
}: ResponsiveTabsProps<T>) {
  const cols = columns ?? tabs.length

  return (
    <>
      {/* Mobile: Shadcn Select dropdown */}
      <div className="sm:hidden">
        <Select value={value} onValueChange={(v) => onValueChange(v as T)}>
          <SelectTrigger className="h-11 text-sm" aria-label={ariaLabel}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {tabs.map((tab) => (
              <SelectItem key={tab} value={tab}>
                {labels[tab]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {/* Desktop: custom children or default tab grid */}
      {children ?? (
        <TabsList className="hidden sm:grid w-full" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {tabs.map((tab) => (
            <TabsTrigger key={tab} value={tab}>
              {labels[tab]}
            </TabsTrigger>
          ))}
        </TabsList>
      )}
    </>
  )
}
