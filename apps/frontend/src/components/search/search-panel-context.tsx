import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { useSidebar } from "@/contexts/sidebar-context"

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
}

const SearchPanelContext = createContext<SearchPanelContextValue | null>(null)

export function SearchPanelProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const navigate = useNavigate()
  const { state, isMobile, togglePinned, collapse } = useSidebar()
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [activeResultId, setActiveResultId] = useState<string | null>(null)

  const openSearch = useCallback(
    (options?: OpenSearchOptions) => {
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
        setActiveResultId(null)
      }
      setIsOpen(true)
      // Search lives in the sidebar — make sure it's actually visible.
      // togglePinned resolves collapsed/preview → pinned on desktop.
      if (state !== "pinned") {
        togglePinned()
      }
    },
    [isMobile, collapse, navigate, workspaceId, state, togglePinned]
  )

  const closeSearch = useCallback(() => {
    setIsOpen(false)
  }, [])

  const value = useMemo(
    () => ({ isOpen, query, setQuery, activeResultId, setActiveResultId, openSearch, closeSearch }),
    [isOpen, query, activeResultId, openSearch, closeSearch]
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
