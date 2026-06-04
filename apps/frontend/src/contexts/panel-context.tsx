import { createContext, useContext, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react"
import { useSearchParams, useLocation } from "react-router-dom"

/** Which pane the user most recently interacted with — drives "copy current link" (mod+L). */
export type FocusedPane = "main" | "panel"

/**
 * Check if a panel ID represents a draft thread
 */
export function isDraftPanel(panelId: string): boolean {
  return panelId.startsWith("draft:")
}

/**
 * Parse draft panel ID to get parent stream and message IDs
 * Returns null if not a draft panel
 */
export function parseDraftPanel(panelId: string): { parentStreamId: string; parentMessageId: string } | null {
  if (!isDraftPanel(panelId)) return null
  const parts = panelId.split(":")
  if (parts.length !== 3) return null
  const [, parentStreamId, parentMessageId] = parts
  if (!parentStreamId || !parentMessageId) return null
  return { parentStreamId, parentMessageId }
}

/**
 * Create a draft panel ID from parent stream and message IDs
 */
export function createDraftPanelId(parentStreamId: string, parentMessageId: string): string {
  return `draft:${parentStreamId}:${parentMessageId}`
}

interface PanelContextValue {
  /** ID of the currently open panel (stream ID or draft panel ID) */
  panelId: string | null
  /** Whether a panel is currently open */
  isPanelOpen: boolean

  /** Generate URL for opening a panel (for use in <a> or <Link> href) */
  getPanelUrl: (streamId: string) => string
  /** Open a panel - streamId can be real stream or "draft:parentStreamId:parentMessageId" */
  openPanel: (streamId: string) => void
  /** Close the current panel */
  closePanel: () => void

  /** Record which pane the user is interacting with (main view vs thread panel). */
  setFocusedPane: (pane: FocusedPane) => void
  /** Read the most recently focused pane. Defaults to "main". */
  getFocusedPane: () => FocusedPane
}

const PanelContext = createContext<PanelContextValue | null>(null)

interface PanelProviderProps {
  children: ReactNode
}

export function PanelProvider({ children }: PanelProviderProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()

  // Parse panel ID from URL - single panel only
  const panelId = useMemo(() => {
    return searchParams.get("panel")
  }, [searchParams])

  const isPanelOpen = panelId !== null

  const getPanelUrl = useCallback(
    (streamId: string) => {
      const newParams = new URLSearchParams(searchParams)
      newParams.set("panel", streamId)
      return `${location.pathname}?${newParams.toString()}`
    },
    [searchParams, location.pathname]
  )

  const openPanel = useCallback(
    (streamId: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set("panel", streamId)
          return next
        },
        { replace: true }
      )
    },
    [setSearchParams]
  )

  const closePanel = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete("panel")
        return next
      },
      { replace: true }
    )
  }, [setSearchParams])

  // Tracked via a ref, not state: only the mod+L handler reads it (on keypress),
  // so updating it on every click/focus must not re-render panel consumers.
  const focusedPaneRef = useRef<FocusedPane>("main")
  const setFocusedPane = useCallback((pane: FocusedPane) => {
    focusedPaneRef.current = pane
  }, [])
  const getFocusedPane = useCallback(() => focusedPaneRef.current, [])

  // When the panel closes, focus belongs to the main pane again.
  useEffect(() => {
    if (panelId === null) focusedPaneRef.current = "main"
  }, [panelId])

  const value = useMemo<PanelContextValue>(
    () => ({
      panelId,
      isPanelOpen,
      getPanelUrl,
      openPanel,
      closePanel,
      setFocusedPane,
      getFocusedPane,
    }),
    [panelId, isPanelOpen, getPanelUrl, openPanel, closePanel, setFocusedPane, getFocusedPane]
  )

  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>
}

export function usePanel(): PanelContextValue {
  const context = useContext(PanelContext)
  if (!context) {
    throw new Error("usePanel must be used within a PanelProvider")
  }
  return context
}
