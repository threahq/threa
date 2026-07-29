import { createContext, useContext, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react"
import { useSearchParams, useLocation, useNavigate, useNavigationType } from "react-router-dom"

/** Which pane the user most recently interacted with — drives "copy current link" (mod+L). */
export type FocusedPane = "main" | "panel"

/**
 * Check if a panel ID represents a draft thread
 */
export function isDraftPanel(panelId: string): boolean {
  return panelId.startsWith("draft:")
}

/**
 * Parse a draft panel id into its parent stream and anchor ids. `anchorId` is the
 * canonical id of the timeline item the draft thread hangs under — `msg_…` for a
 * message, `event_…` for a card (INV-2 prefix discriminates). The id is opaque:
 * message anchors produce byte-identical strings to before, so persisted panel
 * state migrates by construction. Returns null when not a draft panel.
 */
export function parseDraftPanel(panelId: string): { parentStreamId: string; anchorId: string } | null {
  if (!isDraftPanel(panelId)) return null
  const parts = panelId.split(":")
  if (parts.length !== 3) return null
  const [, parentStreamId, anchorId] = parts
  if (!parentStreamId || !anchorId) return null
  return { parentStreamId, anchorId }
}

/**
 * Create a draft panel id from a parent stream id and an anchor id (the canonical
 * id of the timeline item the thread hangs under).
 */
export function createDraftPanelId(parentStreamId: string, anchorId: string): string {
  return `draft:${parentStreamId}:${anchorId}`
}

/** A conversation panel (Mechanism B) opens a single conversation as a projection
 *  peer to a thread, keyed by its conversation id rather than a stream id. */
const CONVERSATION_PANEL_PREFIX = "conv:"

export function isConversationPanel(panelId: string): boolean {
  return panelId.startsWith(CONVERSATION_PANEL_PREFIX)
}

/** The conversation id behind a `conv:<id>` panel, or null when it isn't one. */
export function parseConversationPanel(panelId: string): string | null {
  if (!isConversationPanel(panelId)) return null
  const conversationId = panelId.slice(CONVERSATION_PANEL_PREFIX.length)
  return conversationId || null
}

export function createConversationPanelId(conversationId: string): string {
  return `${CONVERSATION_PANEL_PREFIX}${conversationId}`
}

export interface OpenPanelOptions {
  /** Overwrite the current history entry instead of adding one. Only for a panel
   *  that SUPERSEDES the open one — a draft thread promoted to its real stream —
   *  where going back would land on an id that no longer exists. */
  replace?: boolean
}

interface PanelContextValue {
  /** ID of the currently open panel (stream ID or draft panel ID) */
  panelId: string | null
  /** Whether a panel is currently open */
  isPanelOpen: boolean

  /** Generate URL for opening a panel (for use in <a> or <Link> href) */
  getPanelUrl: (streamId: string) => string
  /** Open a panel - streamId can be real stream or "draft:parentStreamId:anchorId" */
  openPanel: (streamId: string, options?: OpenPanelOptions) => void
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
  const navigate = useNavigate()
  const navigationType = useNavigationType()

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

  // Opening a panel PUSHES: on mobile it takes over the whole screen, so back has
  // to close it rather than leave the page. `<Link to={getPanelUrl(...)}>` (branch
  // rows, thread anchors) already pushed; this makes the imperative path match.
  const openPanel = useCallback(
    (streamId: string, options?: OpenPanelOptions) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set("panel", streamId)
          return next
        },
        { replace: options?.replace ?? false }
      )
    },
    [setSearchParams]
  )

  // True when the history entry underneath the current one is THIS view without a
  // panel — the only case where closing may pop rather than rewrite the URL.
  //
  // Derived from the navigation that produced the current entry rather than
  // recorded by `openPanel`, because most panels open through
  // `<Link to={getPanelUrl(...)}>` (INV-40) and never call it. Popping a deep link
  // or a reload would navigate the user off the page — possibly out of the app —
  // so anything but a same-view PUSH closes by rewriting the URL instead.
  const canPopToClose = useRef(false)
  const viewRef = useRef<string | null>(null)
  const locationKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (location.key === locationKeyRef.current) return
    locationKeyRef.current = location.key
    const params = new URLSearchParams(location.search)
    params.delete("panel")
    const previousView = viewRef.current
    // Panel-agnostic, so switching panels in place still counts as the same view:
    // closing then behaves like back, which is what the affordance reads as.
    const view = `${location.pathname}?${params.toString()}`
    viewRef.current = view
    if (panelId === null) canPopToClose.current = false
    // A replace leaves the entry below untouched, so the claim carries over.
    else if (navigationType !== "REPLACE") canPopToClose.current = navigationType === "PUSH" && previousView === view
  }, [location.key, location.pathname, location.search, navigationType, panelId])

  const closePanel = useCallback(() => {
    if (canPopToClose.current) {
      canPopToClose.current = false
      navigate(-1)
      return
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete("panel")
        return next
      },
      { replace: true }
    )
  }, [navigate, setSearchParams])

  // Tracked via a ref, not state: only the copy-link shortcut reads it (on
  // keypress), so updating it on every click/focus must not re-render panel
  // consumers. Seed from the initial URL so a deep link that opens a panel
  // (which then autofocuses) reports the panel before any pointer interaction.
  const focusedPaneRef = useRef<FocusedPane>(panelId !== null ? "panel" : "main")
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
