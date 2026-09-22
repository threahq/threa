import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react"
import type { CollapsibleBodyGroup } from "@/lib/markdown/collapsible-body"
import type { RunFold, RunFoldStore } from "./run-fold"

interface RunFoldContextValue {
  store: RunFoldStore
  fold: RunFold | undefined
}

const RunFoldContext = createContext<RunFoldContextValue | null>(null)

export function RunFoldProvider({
  store,
  fold,
  children,
}: {
  store: RunFoldStore
  fold: RunFold | undefined
  children: ReactNode
}) {
  const value = useMemo(() => ({ store, fold }), [store, fold])
  return <RunFoldContext.Provider value={value}>{children}</RunFoldContext.Provider>
}

/**
 * Wires one message body into its run's fold: reports the body's height to the
 * store, and hands the body the run's state and control in place of its own.
 */
export function useRunFoldBody(messageId: string): {
  onHeight: ((heightPx: number) => void) | undefined
  group: CollapsibleBodyGroup | undefined
} {
  const context = useContext(RunFoldContext)
  const store = context?.store
  const fold = context?.fold

  const onHeight = useCallback((heightPx: number) => store?.reportHeight(messageId, heightPx), [store, messageId])

  const group = useMemo((): CollapsibleBodyGroup | undefined => {
    if (!store || !fold) return undefined
    if (fold.state === "folded") {
      const count = fold.hiddenCount
      const unread = fold.unreadCount > 0 ? ` · ${fold.unreadCount} new` : ""
      return {
        collapsed: true,
        toggleLabel: `Show ${count} more message${count === 1 ? "" : "s"}${unread}`,
        onToggle: () => store.setCollapsed(fold, false),
      }
    }
    return {
      collapsed: false,
      toggleLabel: fold.isLast ? "Collapse" : null,
      onToggle: () => store.setCollapsed(fold, true),
    }
  }, [store, fold])

  return { onHeight: store ? onHeight : undefined, group }
}
