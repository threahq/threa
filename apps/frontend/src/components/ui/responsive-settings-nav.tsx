import { useCallback } from "react"
import { cn } from "@/lib/utils"
import { ResponsiveTabs } from "./responsive-tabs"

interface SettingsNavItem {
  label: string
  description?: string
}

interface ResponsiveSettingsNavProps<T extends string> {
  tabs: readonly T[]
  items: Record<T, SettingsNavItem>
  value: T
  onValueChange: (value: T) => void
}

export const SETTINGS_DIALOG_LAYOUT_CLASSNAMES = {
  tabs: "flex min-h-0 flex-1 flex-col",
  panels: "flex min-h-0 flex-1 flex-col overflow-hidden sm:grid sm:grid-cols-[220px,minmax(0,1fr)]",
  content: "flex-1 min-h-0 overflow-y-auto px-4 pb-4 pt-6 scrollbar-thin sm:px-6 sm:py-6",
} as const

export function ResponsiveSettingsNav<T extends string>({
  tabs,
  items,
  value,
  onValueChange,
}: ResponsiveSettingsNavProps<T>) {
  const labels = Object.fromEntries(tabs.map((tab) => [tab, items[tab].label])) as Record<T, string>

  // Opening straight to a bottom-of-list tab (?settings=…) otherwise leaves the
  // active row clipped behind the nav's own scroll edge.
  const activeRef = useCallback((node: HTMLButtonElement | null) => {
    node?.scrollIntoView({ block: "nearest" })
  }, [])

  return (
    <ResponsiveTabs tabs={tabs} labels={labels} value={value} onValueChange={onValueChange}>
      <div
        data-slot="settings-nav"
        className="hidden h-full min-h-0 flex-col gap-0.5 overflow-y-auto border-r p-2 scrollbar-thin sm:flex"
      >
        {tabs.map((tab) => {
          const item = items[tab]
          const isActive = tab === value

          return (
            <button
              key={tab}
              ref={isActive ? activeRef : undefined}
              type="button"
              onClick={() => onValueChange(tab)}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "rounded-md px-3 py-2 text-left transition-colors",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              )}
            >
              <div className="text-sm font-medium">{item.label}</div>
              {item.description ? (
                <div
                  className={cn("mt-0.5 text-xs", isActive ? "text-accent-foreground/75" : "text-muted-foreground/80")}
                >
                  {item.description}
                </div>
              ) : null}
            </button>
          )
        })}
      </div>
    </ResponsiveTabs>
  )
}
