import { createContext, useContext, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react"
import { useSearchParams, useLocation, useNavigate, useParams } from "react-router-dom"
import { panelIdToMainPath, mainPathToPanelId } from "@/lib/panel-locations"

/**
 * Which pane the user most recently interacted with. "main" is the routed
 * page; any other value is the id of an open side panel.
 */
export type FocusedPane = "main" | string

// Pane id helpers live with the route mapping; re-exported here for the many
// existing call sites that import them from the context module.
export { isDraftPanel, parseDraftPanel, createDraftPanelId, isViewPanel } from "@/lib/panel-locations"

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

  /**
   * The id of pane 0 — the surface the routed page shows — or null when the
   * current page has no pane equivalent (settings-ish pages). Pane 0 is not a
   * special kind of pane; the URL just encodes its surface in the path
   * instead of a `?panel=` param.
   */
  paneZeroId: string | null
  /** Every open pane in visual order: pane 0 (when managed) plus the strip. */
  panes: string[]
  /**
   * Move a pane to a new index in the combined order. Moving across index 0
   * navigates: the surface at index 0 is the routed page.
   */
  movePane: (paneId: string, toIndex: number) => void
  /** Close any pane. Closing pane 0 promotes the next pane to the route. */
  closePane: (paneId: string) => void

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

/**
 * How many side panels fit comfortably. Mobile gets exactly one; desktop
 * scales with viewport width (a wide monitor fits many, a laptop two or
 * three). Interactive opens beyond the cap replace the last panel instead of
 * appending — deep links with more panels still render them all.
 */
export function maxSidePanels(viewportWidth: number): number {
  if (viewportWidth < 640) return 1
  return Math.max(1, Math.min(8, Math.floor((viewportWidth - 600) / 360)))
}

export function PanelProvider({ children }: PanelProviderProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { workspaceId } = useParams<{ workspaceId: string }>()

  const panels = useMemo(() => searchParams.getAll("panel"), [searchParams])
  const panelId = panels.length > 0 ? panels[panels.length - 1] : null
  const isPanelOpen = panels.length > 0
  const paneZeroId = useMemo(() => mainPathToPanelId(location.pathname), [location.pathname])
  const panes = useMemo(() => (paneZeroId ? [paneZeroId, ...panels] : panels), [paneZeroId, panels])

  const panelsRef = useRef(panels)
  panelsRef.current = panels
  const locationRef = useRef(location)
  locationRef.current = location

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

  /**
   * Write a new combined pane order. Index 0 is encoded in the path, the rest
   * in `?panel=` params — when index 0 changes this navigates (a history
   * entry: the routed surface changed), otherwise it rewrites params in
   * place. Non-routable panes (drafts) are clamped out of index 0.
   */
  const writePanes = useCallback(
    (transform: (prev: string[]) => string[]) => {
      const loc = locationRef.current
      const prevZero = mainPathToPanelId(loc.pathname)
      const prevPanels = new URLSearchParams(loc.search).getAll("panel")
      const prev = prevZero ? [prevZero, ...prevPanels] : prevPanels
      const next = transform(prev)
      if (next.length === prev.length && next.every((id, i) => id === prev[i])) return

      if (!prevZero) {
        // The routed page has no pane equivalent — everything lives in params.
        writePanels(() => next)
        return
      }

      const params = new URLSearchParams(loc.search)
      params.delete("panel")
      const nextZero = next[0] ?? null
      for (const id of next.slice(1)) params.append("panel", id)

      if (!nextZero) {
        navigate(`/w/${workspaceId}`)
        return
      }
      if (nextZero === prevZero) {
        setSearchParams(params, { replace: true })
        return
      }
      const path = panelIdToMainPath(workspaceId ?? "", nextZero)
      if (!path) return
      const search = params.toString()
      navigate(`${path}${search ? `?${search}` : ""}`)
    },
    [writePanels, setSearchParams, navigate, workspaceId]
  )

  const movePane = useCallback(
    (paneId: string, toIndex: number) => {
      writePanes((prev) => {
        const from = prev.indexOf(paneId)
        if (from === -1) return prev
        // When index 0 is the routed page, a pane with no route can't take it.
        const zeroIsRouted = mainPathToPanelId(locationRef.current.pathname) != null
        const floor = !zeroIsRouted || panelIdToMainPath(workspaceId ?? "", paneId) ? 0 : 1
        const to = Math.max(floor, Math.min(toIndex, prev.length - 1))
        if (to === from) return prev
        const next = [...prev]
        next.splice(from, 1)
        next.splice(to, 0, paneId)
        return next
      })
    },
    [writePanes, workspaceId]
  )

  const closePane = useCallback(
    (paneId: string) => {
      writePanes((prev) => prev.filter((p) => p !== paneId))
    },
    [writePanes]
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
      writePanels((prev) => {
        // Appending beyond what the viewport fits degrades to replacing the
        // last panel — mobile gets exactly one, wide screens get many.
        const cap = maxSidePanels(typeof window === "undefined" ? Infinity : window.innerWidth)
        const effective = options?.mode === "new" && prev.length >= cap ? { ...options, mode: undefined } : options
        return applyOpenPanel(prev, streamId, effective)
      })
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
      paneZeroId,
      panes,
      movePane,
      closePane,
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
      paneZeroId,
      panes,
      movePane,
      closePane,
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
