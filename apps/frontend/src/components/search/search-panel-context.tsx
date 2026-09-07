import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { useSidebar } from "@/contexts/sidebar-context"
import { capture } from "@/lib/analytics/posthog"
import type { SearchRefinement } from "@threahq/types"

interface OpenSearchOptions {
  /** Seed the search input (e.g. text carried over from the quick switcher). */
  query?: string
}

interface SearchPanelContextValue {
  /** Desktop only — true while the sidebar is in search mode. */
  isOpen: boolean
  /** The current search query (shared so reopening the panel restores it). */
  query: string
  setQuery: (query: string) => void
  /** Committed refinements, oldest first; each is a removable chip. */
  refines: SearchRefinement[]
  setRefines: (refines: SearchRefinement[]) => void
  /** Result the user last opened — drives the active row styling. */
  activeResultId: string | null
  setActiveResultId: (id: string | null) => void
  /**
   * Open workspace search. Desktop: switches the sidebar into search mode
   * (pinning it if collapsed). Mobile: navigates to the full-page search view.
   */
  openSearch: (options?: OpenSearchOptions) => void
  /** Leave search mode and return the sidebar to the stream list. */
  closeSearch: () => void
  /**
   * The mounted panel registers how to focus its input so `openSearch` can
   * refocus it when the panel is already open (mod+shift+f after focus
   * wandered elsewhere). Pass null on unmount.
   */
  registerFocusHandler: (handler: (() => void) | null) => void
}

const SearchPanelContext = createContext<SearchPanelContextValue | null>(null)

export function SearchPanelProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const navigate = useNavigate()
  const { state, isMobile, togglePinned, collapse } = useSidebar()
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [refines, setRefines] = useState<SearchRefinement[]>([])
  const [activeResultId, setActiveResultId] = useState<string | null>(null)

  const focusInputRef = useRef<(() => void) | null>(null)
  const registerFocusHandler = useCallback((handler: (() => void) | null) => {
    focusInputRef.current = handler
  }, [])

  const openSearch = useCallback(
    (options?: OpenSearchOptions) => {
      capture("search_opened")
      if (isMobile) {
        // Mobile gets the full-page experience (mirrors memory/file explorer).
        // The sidebar overlay would otherwise sit on top of the page.
        collapse()
        const params = new URLSearchParams()
        if (options?.query) params.set("q", options.query)
        const suffix = params.size > 0 ? `?${params.toString()}` : ""
        navigate(`/w/${workspaceId}/search${suffix}`)
        return
      }

      if (options?.query !== undefined) {
        setQuery(options.query)
        setRefines([])
        setActiveResultId(null)
      }
      setIsOpen(true)
      // Search lives in the sidebar — make sure it's actually visible.
      // togglePinned resolves collapsed/preview → pinned on desktop.
      if (state !== "pinned") {
        togglePinned()
      }
      // Already-open panel: refocus the input (first open is handled by the
      // panel's own autoFocus — no handler is registered yet at that point).
      focusInputRef.current?.()
    },
    [isMobile, collapse, navigate, workspaceId, state, togglePinned]
  )

  const closeSearch = useCallback(() => {
    setIsOpen(false)
  }, [])

  const value = useMemo(
    () => ({
      isOpen,
      query,
      setQuery,
      refines,
      setRefines,
      activeResultId,
      setActiveResultId,
      openSearch,
      closeSearch,
      registerFocusHandler,
    }),
    [isOpen, query, refines, activeResultId, openSearch, closeSearch, registerFocusHandler]
  )

  return <SearchPanelContext.Provider value={value}>{children}</SearchPanelContext.Provider>
}

export function useSearchPanel() {
  const context = useContext(SearchPanelContext)
  if (!context) {
    throw new Error("useSearchPanel must be used within a SearchPanelProvider")
  }
  return context
}
