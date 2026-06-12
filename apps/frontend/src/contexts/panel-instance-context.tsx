import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react"
import { usePanel, type OpenPanelOptions } from "./panel-context"

/**
 * Identifies the pane a component is rendered inside. The workspace panel
 * strip provides one per panel; content in the routed main view gets the
 * default ("main"). Deep components (message rows, breadcrumbs) read this to
 * scope navigation to their own pane instead of hijacking a neighbor panel.
 */
interface PanelInstanceValue {
  /** The containing panel's id, or null when rendered in the main view. */
  panelId: string | null
  /** Props to spread on the panel header to make it the drag handle. */
  dragHandleProps?: {
    onPointerDown: (e: React.PointerEvent) => void
  }
}

const PanelInstanceContext = createContext<PanelInstanceValue>({ panelId: null })

export function PanelInstanceProvider({
  panelId,
  dragHandleProps,
  children,
}: PanelInstanceValue & { children: ReactNode }) {
  const value = useMemo(() => ({ panelId, dragHandleProps }), [panelId, dragHandleProps])
  return <PanelInstanceContext.Provider value={value}>{children}</PanelInstanceContext.Provider>
}

export function usePanelInstance(): PanelInstanceValue {
  return useContext(PanelInstanceContext)
}

/** Reactive focused-pane value — "main" or a panel id. */
export function useFocusedPane() {
  const { focusedPaneStore } = usePanel()
  return useSyncExternalStore(focusedPaneStore.subscribe, focusedPaneStore.get)
}

/**
 * Pane-scoped navigation: getPanelUrl/openPanel that default to replacing the
 * pane the calling component lives in. In the main view they fall through to
 * the default behavior (replace the most recent panel / open the first one).
 */
export function usePanelNavigation() {
  const { getPanelUrl, openPanel, closePanel, setFocusedPane } = usePanel()
  const { panelId } = usePanelInstance()

  return useMemo(
    () => ({
      /** The containing panel's id, or null in the main view. */
      ownPanelId: panelId,
      getPanelUrl: (id: string, options?: OpenPanelOptions) =>
        getPanelUrl(id, { target: panelId ?? undefined, ...options }),
      openPanel: (id: string, options?: OpenPanelOptions) =>
        openPanel(id, { target: panelId ?? undefined, ...options }),
      /** Close the containing panel (no-op in the main view). */
      closeOwnPanel: () => {
        if (panelId) closePanel(panelId)
      },
      /** Mark the containing pane as the focused one. */
      focusOwnPane: () => setFocusedPane(panelId ?? "main"),
    }),
    [panelId, getPanelUrl, openPanel, closePanel, setFocusedPane]
  )
}
