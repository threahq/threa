import { createContext, useContext, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react"
import { useSearchParams, useLocation } from "react-router-dom"

/**
 * Which pane the user most recently interacted with. "main" is the routed
 * page; any other value is the id of an open side panel.
 */
export type FocusedPane = "main" | string

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

/** Check if a panel ID is a named view surface (e.g. "view:saved"). */
export function isViewPanel(panelId: string): boolean {
  return panelId.startsWith("view:")
}

export interface OpenPanelOptions {
  /**
   * "replace" (default) swaps the target panel's content in place — the
   * single-panel behavior every existing call site expects. "new" appends
   * another panel to the strip (used by cmd-click and explicit split actions).
   */
  mode?: "replace" | "new"
  /**
   * Which open panel to replace in "replace" mode. Defaults to the most
   * recently opened panel. Content rendered inside a panel should pass its
   * own panel id (via usePanelInstance) so in-panel navigation stays in that
   * panel instead of hijacking its neighbor.
   */
  target?: string
}

/**
 * Pure transform: the next ordered panel list after opening `id`.
 * Opening an already-open panel is a no-op (the caller focuses it instead).
 */
export function applyOpenPanel(panels: string[], id: string, options?: OpenPanelOptions): string[] {
  if (panels.includes(id)) return panels
  if (options?.mode === "new" || panels.length === 0) return [...panels, id]
  const target = options?.target && panels.includes(options.target) ? options.target : panels[panels.length - 1]
  return panels.map((p) => (p === target ? id : p))
}

/**
 * Reactive store for the focused pane. Kept outside React state so that
 * read-on-keypress consumers (copy-link) never re-render, while visual
 * consumers (focus ring, keyboard cycling) can subscribe via
 * useSyncExternalStore in useFocusedPane().
 */
export interface FocusedPaneStore {
  get: () => FocusedPane
  set: (pane: FocusedPane) => void
  subscribe: (listener: () => void) => () => void
}

function createFocusedPaneStore(initial: FocusedPane): FocusedPaneStore {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    set: (pane) => {
      if (pane === current) return
      current = pane
      listeners.forEach((l) => l())
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

interface PanelContextValue {
  /** Ordered ids of the open side panels (left to right). */
  panels: string[]
  /** Most recently opened panel id, or null. */
  panelId: string | null
  /** Whether any panel is open. */
  isPanelOpen: boolean

  /** Generate URL for opening a panel (for use in <a> or <Link> href). */
  getPanelUrl: (streamId: string, options?: OpenPanelOptions) => string
  /** Open a panel — stream id, "draft:parent:message", or "view:<name>". */
  openPanel: (streamId: string, options?: OpenPanelOptions) => void
  /** Close one panel (defaults to the last/most recent). */
  closePanel: (panelId?: string) => void
  /** Close every open panel, optionally keeping one. */
  closeAllPanels: (exceptId?: string) => void
  /** Move an open panel to a new index in the strip. */
  movePanel: (panelId: string, toIndex: number) => void
  /** Swap a panel's content with another id in place (e.g. draft promotion). */
  replacePanel: (panelId: string, nextId: string) => void

  /** Record which pane the user is interacting with. */
  setFocusedPane: (pane: FocusedPane) => void
  /** Read the most recently focused pane without subscribing. */
  getFocusedPane: () => FocusedPane
  /** Subscription store backing useFocusedPane(). */
  focusedPaneStore: FocusedPaneStore
}

const PanelContext = createContext<PanelContextValue | null>(null)

interface PanelProviderProps {
  children: ReactNode
}

export function PanelProvider({ children }: PanelProviderProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()

  const panels = useMemo(() => searchParams.getAll("panel"), [searchParams])
  const panelId = panels.length > 0 ? panels[panels.length - 1] : null
  const isPanelOpen = panels.length > 0

  const panelsRef = useRef(panels)
  panelsRef.current = panels

  const storeRef = useRef<FocusedPaneStore | null>(null)
  if (!storeRef.current) {
    // Seed from the initial URL so a deep link that opens a panel (which then
    // autofocuses) reports the panel before any pointer interaction.
    storeRef.current = createFocusedPaneStore(panelId ?? "main")
  }
  const focusedPaneStore = storeRef.current

  const writePanels = useCallback(
    (transform: (prev: string[]) => string[]) => {
      setSearchParams(
        (prev) => {
          const current = prev.getAll("panel")
          const nextPanels = transform(current)
          const next = new URLSearchParams(prev)
          next.delete("panel")
          for (const id of nextPanels) next.append("panel", id)
          return next
        },
        { replace: true }
      )
    },
    [setSearchParams]
  )

  const getPanelUrl = useCallback(
    (streamId: string, options?: OpenPanelOptions) => {
      const newParams = new URLSearchParams(searchParams)
      const nextPanels = applyOpenPanel(searchParams.getAll("panel"), streamId, options)
      newParams.delete("panel")
      for (const id of nextPanels) newParams.append("panel", id)
      return `${location.pathname}?${newParams.toString()}`
    },
    [searchParams, location.pathname]
  )

  const openPanel = useCallback(
    (streamId: string, options?: OpenPanelOptions) => {
      writePanels((prev) => applyOpenPanel(prev, streamId, options))
      focusedPaneStore.set(streamId)
    },
    [writePanels, focusedPaneStore]
  )

  const closePanel = useCallback(
    (id?: string) => {
      writePanels((prev) => {
        const target = id ?? prev[prev.length - 1]
        return prev.filter((p) => p !== target)
      })
    },
    [writePanels]
  )

  const closeAllPanels = useCallback(
    (exceptId?: string) => {
      writePanels((prev) => prev.filter((p) => p === exceptId))
    },
    [writePanels]
  )

  const movePanel = useCallback(
    (id: string, toIndex: number) => {
      writePanels((prev) => {
        const from = prev.indexOf(id)
        if (from === -1) return prev
        const next = [...prev]
        next.splice(from, 1)
        next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, id)
        return next
      })
    },
    [writePanels]
  )

  const replacePanel = useCallback(
    (id: string, nextId: string) => {
      if (id === nextId) return
      writePanels((prev) => {
        // If the replacement is already open elsewhere, just drop the old one.
        if (prev.includes(nextId)) return prev.filter((p) => p !== id)
        return prev.map((p) => (p === id ? nextId : p))
      })
      if (focusedPaneStore.get() === id) focusedPaneStore.set(nextId)
    },
    [writePanels, focusedPaneStore]
  )

  const setFocusedPane = useCallback((pane: FocusedPane) => focusedPaneStore.set(pane), [focusedPaneStore])
  const getFocusedPane = useCallback(() => focusedPaneStore.get(), [focusedPaneStore])

  // When the focused panel closes, focus belongs to the main pane again.
  useEffect(() => {
    const focused = focusedPaneStore.get()
    if (focused !== "main" && !panels.includes(focused)) {
      focusedPaneStore.set("main")
    }
  }, [panels, focusedPaneStore])

  const value = useMemo<PanelContextValue>(
    () => ({
      panels,
      panelId,
      isPanelOpen,
      getPanelUrl,
      openPanel,
      closePanel,
      closeAllPanels,
      movePanel,
      replacePanel,
      setFocusedPane,
      getFocusedPane,
      focusedPaneStore,
    }),
    [
      panels,
      panelId,
      isPanelOpen,
      getPanelUrl,
      openPanel,
      closePanel,
      closeAllPanels,
      movePanel,
      replacePanel,
      setFocusedPane,
      getFocusedPane,
      focusedPaneStore,
    ]
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
