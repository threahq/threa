import { useRef, useEffect } from "react"
import { cn } from "@/lib/utils"
import { ResponsiveTabs } from "@/components/ui/responsive-tabs"
import type { QuickSwitcherMode } from "./quick-switcher"

interface ModeTabsProps {
  currentMode: QuickSwitcherMode
  onModeChange: (mode: QuickSwitcherMode) => void
  focusedTabIndex: number | null
  onFocusedTabIndexChange: (index: number | null) => void
  onTabSelect: () => void
}

const MODES: { mode: QuickSwitcherMode; label: string; shortcut: string | null }[] = [
  { mode: "stream", label: "Stream search", shortcut: null },
  { mode: "command", label: "Command palette", shortcut: ">" },
]

const TAB_VALUES = MODES.map((m) => m.mode) as readonly QuickSwitcherMode[]

const TAB_LABELS = Object.fromEntries(MODES.map((m) => [m.mode, m.label])) as Record<QuickSwitcherMode, string>

export function ModeTabs({
  currentMode,
  onModeChange,
  focusedTabIndex,
  onFocusedTabIndexChange,
  onTabSelect,
}: ModeTabsProps) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const isMountedRef = useRef(true)

  // Track mounted state to prevent rAF callbacks after unmount
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  // Focus the tab when focusedTabIndex changes
  useEffect(() => {
    if (focusedTabIndex !== null && tabRefs.current[focusedTabIndex]) {
      tabRefs.current[focusedTabIndex]?.focus()
    }
  }, [focusedTabIndex])

  const handleTabKeyDown = (e: React.KeyboardEvent, index: number) => {
    // Let Tab work naturally for accessibility - browser handles tab order
    // Arrow keys for quick navigation within tabs
    switch (true) {
      case e.key === "ArrowRight":
        e.preventDefault()
        const nextIndex = (index + 1) % MODES.length
        onFocusedTabIndexChange(nextIndex)
        tabRefs.current[nextIndex]?.focus()
        break
      case e.key === "ArrowLeft":
        e.preventDefault()
        const prevIndex = (index - 1 + MODES.length) % MODES.length
        onFocusedTabIndexChange(prevIndex)
        tabRefs.current[prevIndex]?.focus()
        break
      case e.key === "Enter" || e.key === " ":
        e.preventDefault()
        const mode = MODES[index].mode
        onModeChange(mode)
        onTabSelect()
        break
    }
  }

  const handleTabClick = (mode: QuickSwitcherMode) => {
    onModeChange(mode)
    onFocusedTabIndexChange(null)
    onTabSelect()
  }

  return (
    <div className="p-2 border-b">
      <ResponsiveTabs
        tabs={TAB_VALUES}
        labels={TAB_LABELS}
        value={currentMode}
        onValueChange={(v) => handleTabClick(v)}
      >
        {/* Desktop: custom pill buttons with keyboard navigation */}
        <div className="hidden sm:flex gap-1" role="tablist" aria-label="Quick switcher modes">
          {MODES.map(({ mode, label, shortcut }, index) => {
            const isSelected = mode === currentMode

            return (
              <button
                key={mode}
                ref={(el) => {
                  tabRefs.current[index] = el
                }}
                role="tab"
                aria-selected={isSelected}
                tabIndex={0}
                onClick={() => handleTabClick(mode)}
                onKeyDown={(e) => handleTabKeyDown(e, index)}
                onFocus={() => onFocusedTabIndexChange(index)}
                onBlur={() => {
                  // Only clear if we're not moving to another tab
                  requestAnimationFrame(() => {
                    if (!isMountedRef.current) return
                    const activeElement = document.activeElement
                    const isTabFocused = tabRefs.current.some((ref) => ref === activeElement)
                    if (!isTabFocused) {
                      onFocusedTabIndexChange(null)
                    }
                  })
                }}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium transition-colors rounded-pill",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                  isSelected
                    ? "bg-primary/15 text-primary border border-primary/40"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary border border-transparent"
                )}
              >
                {shortcut && <span className="text-muted-foreground mr-1">({shortcut})</span>}
                {label}
              </button>
            )
          })}
        </div>
      </ResponsiveTabs>
    </div>
  )
}
