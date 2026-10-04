import { createContext, useContext, useMemo } from "react"
import type { QuickSwitcherMode } from "@/components/quick-switcher"

interface QuickSwitcherContextValue {
  openSwitcher: (mode: QuickSwitcherMode) => void
}

const QuickSwitcherContext = createContext<QuickSwitcherContextValue | null>(null)

export function QuickSwitcherProvider({
  children,
  openSwitcher,
}: {
  children: React.ReactNode
  openSwitcher: (mode: QuickSwitcherMode) => void
}) {
  const value = useMemo(() => ({ openSwitcher }), [openSwitcher])
  return <QuickSwitcherContext.Provider value={value}>{children}</QuickSwitcherContext.Provider>
}

export function useQuickSwitcher() {
  const context = useContext(QuickSwitcherContext)
  if (!context) {
    throw new Error("useQuickSwitcher must be used within QuickSwitcherProvider")
  }
  return context
}
