import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from "react"
import { useIsMobile } from "@/hooks/use-mobile"
import { useAccountScopeOptional } from "@/auth/account-scope"

/**
 * Sidebar states:
 * - collapsed: 6px color strip only, content hidden
 * - preview: user-defined width, positioned absolutely (doesn't push content), triggered by hover
 * - pinned: user-defined width, positioned normally (pushes main content)
 */
type SidebarState = "collapsed" | "preview" | "pinned"

/** Simplified open state for persistence (preview is transient) */
type SidebarOpenState = "open" | "collapsed"

/**
 * Binary open/collapsed state for a collapsible sidebar section.
 * Sections with activity still surface an aggregate badge when collapsed so
 * the user's attention is pulled to them.
 */
type CollapseState = "open" | "collapsed"

/** Urgency block for position-matched collapsed strip */
interface UrgencyBlock {
  /** Position as fraction of total list height (0 to 1) */
  position: number
  /** Height as fraction of total list height */
  height: number
  /** CSS color for this urgency level */
  color: string
  /** Opacity for fade transitions (0-1) */
  opacity: number
}

/** Persisted sidebar state (single localStorage key) */
interface SidebarPersistedState {
  openState: SidebarOpenState
  width: number
  /** Per-section open/collapsed state. Absent keys fall back to per-section defaults at the callsite. */
  sectionStates: Record<string, CollapseState>
}

const MIN_SIDEBAR_WIDTH = 200
const MAX_SIDEBAR_WIDTH = 400
const DEFAULT_SIDEBAR_WIDTH = 260
const SIDEBAR_STATE_KEY = "threa-sidebar-state"

const DEFAULT_PERSISTED_STATE: SidebarPersistedState = {
  openState: "open",
  width: DEFAULT_SIDEBAR_WIDTH,
  sectionStates: {
    "quick-links": "open",
    other: "collapsed",
  },
}

interface SidebarContextValue {
  /** Current sidebar state */
  state: SidebarState
  /** Current sidebar width in pixels */
  width: number
  /** Open/collapsed state per section key. Use `getSectionState` for reads with defaults. */
  sectionStates: Record<string, CollapseState>
  /** Read a section's state, falling back to the provided default (default: "open"). */
  getSectionState: (section: string, defaultState?: CollapseState) => CollapseState
  /** Whether viewport is mobile-sized */
  isMobile: boolean
  /** Whether sidebar is currently being hovered (for hover margin behavior) */
  isHovering: boolean
  /** Whether sidebar is currently being resized */
  isResizing: boolean
  /** Position-matched urgency blocks for collapsed strip */
  urgencyBlocks: Map<string, UrgencyBlock>
  /** Total height of sidebar (for position calculations) */
  sidebarHeight: number
  /** Offset from sidebar top to scroll viewport top (header) */
  scrollContainerOffset: number
  /** Monotonic counter bumped on sidebar scroll so position-tracked glow blocks re-measure */
  scrollVersion: number
  /** Show preview state on hover (only from collapsed) */
  showPreview: () => void
  /** Hide preview state after delay */
  hidePreview: () => void
  /** Toggle between collapsed and pinned */
  togglePinned: () => void
  /** Collapse the sidebar (from pinned) */
  collapse: () => void
  /** Collapse the sidebar only when on mobile (no-op on desktop) */
  collapseOnMobile: () => void
  /** Set hovering state */
  setHovering: (hovering: boolean) => void
  /** Start resizing */
  startResizing: () => void
  /** Stop resizing */
  stopResizing: () => void
  /** Set sidebar width */
  setWidth: (width: number) => void
  /**
   * Flip a section between open and collapsed.
   * If no state has been stored yet, flips from `defaultState` (default: "open").
   */
  toggleSectionState: (section: string, defaultState?: CollapseState) => void
  /** Force a section to a specific state without toggling. */
  setSectionState: (section: string, state: CollapseState) => void
  /** Set urgency block for a stream item (opacity is added automatically) */
  setUrgencyBlock: (streamId: string, block: Omit<UrgencyBlock, "opacity"> | null) => void
  /** Set sidebar height */
  setSidebarHeight: (height: number) => void
  /** Set scroll container offset from sidebar top */
  setScrollContainerOffset: (offset: number) => void
  /** Bump `scrollVersion` to trigger re-measurement of glow block positions */
  bumpScrollVersion: () => void
  /** Notify that a menu inside the sidebar opened/closed (prevents collapse while open) */
  setMenuOpen: (open: boolean) => void
}

const SidebarContext = createContext<SidebarContextValue | null>(null)

const HIDE_DELAY_MS = 150

interface SidebarProviderProps {
  children: ReactNode
}

/** Shape of legacy persisted state (pre-binary migration). */
interface LegacyPersistedShape {
  collapsedSections?: unknown
  quickLinksState?: unknown
}

/** Coerce any persisted value (including legacy "auto") into the binary shape. */
function coerceCollapseState(value: unknown): CollapseState | null {
  if (value === "open" || value === "auto") return "open"
  if (value === "collapsed") return "collapsed"
  return null
}

function readSectionStates(
  parsed: Partial<SidebarPersistedState> & LegacyPersistedShape
): Record<string, CollapseState> {
  const next: Record<string, CollapseState> = {}

  if (parsed.sectionStates && typeof parsed.sectionStates === "object") {
    for (const [key, value] of Object.entries(parsed.sectionStates)) {
      const coerced = coerceCollapseState(value)
      if (coerced) next[key] = coerced
    }
  }

  // Migrate legacy `collapsedSections: string[]` — each entry becomes "collapsed"
  if (Array.isArray(parsed.collapsedSections)) {
    for (const key of parsed.collapsedSections) {
      if (typeof key === "string" && !(key in next)) next[key] = "collapsed"
    }
  }

  // Migrate legacy `quickLinksState` if present and the new key isn't set
  const legacyQuickLinks = coerceCollapseState(parsed.quickLinksState)
  if (legacyQuickLinks && !("quick-links" in next)) {
    next["quick-links"] = legacyQuickLinks
  }

  return Object.keys(next).length > 0 ? next : DEFAULT_PERSISTED_STATE.sectionStates
}

function getStoredState(key: string): SidebarPersistedState {
  try {
    const stored = localStorage.getItem(key)
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<SidebarPersistedState> & LegacyPersistedShape
      return {
        openState: parsed.openState === "collapsed" ? "collapsed" : "open",
        width:
          typeof parsed.width === "number" && parsed.width >= MIN_SIDEBAR_WIDTH && parsed.width <= MAX_SIDEBAR_WIDTH
            ? parsed.width
            : DEFAULT_PERSISTED_STATE.width,
        sectionStates: readSectionStates(parsed),
      }
    }
  } catch {
    // localStorage not available or invalid JSON
  }
  return DEFAULT_PERSISTED_STATE
}

function storeState(key: string, state: SidebarPersistedState): void {
  try {
    localStorage.setItem(key, JSON.stringify(state))
  } catch {
    // localStorage not available
  }
}

export function SidebarProvider({ children }: SidebarProviderProps) {
  // Account-scoped storage key so each logged-in account keeps its own sidebar
  // layout. Falls back to the un-namespaced key pre-auth and in isolated unit
  // tests (no AccountScopeProvider), preserving prior behavior there.
  const accountScope = useAccountScopeOptional()
  const storageKey = accountScope?.activeWorkosUserId
    ? `${SIDEBAR_STATE_KEY}:${accountScope.activeWorkosUserId}`
    : SIDEBAR_STATE_KEY

  // Load persisted state on mount
  const [persistedState, setPersistedState] = useState<SidebarPersistedState>(() => getStoredState(storageKey))

  // Runtime state (preview is transient, not persisted)
  const isMobile = useIsMobile()
  const [state, setState] = useState<SidebarState>(() =>
    isMobile || persistedState.openState === "collapsed" ? "collapsed" : "pinned"
  )
  const [isHovering, setIsHovering] = useState(false)
  const isHoveringRef = useRef(false)
  const [isResizing, setIsResizing] = useState(false)
  const [urgencyBlocks, setUrgencyBlocks] = useState<Map<string, UrgencyBlock>>(new Map())
  const [sidebarHeight, setSidebarHeight] = useState(0)
  const [scrollContainerOffset, setScrollContainerOffset] = useState(0)
  const [scrollVersion, setScrollVersion] = useState(0)
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fadeOutTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const menuOpenCountRef = useRef(0)

  // Persist state changes
  const updatePersistedState = useCallback(
    (updates: Partial<SidebarPersistedState>) => {
      setPersistedState((current) => {
        const next = { ...current, ...updates }
        storeState(storageKey, next)
        return next
      })
    },
    [storageKey]
  )

  // Auto-collapse when transitioning to mobile
  useEffect(() => {
    if (isMobile) {
      setState("collapsed")
    }
  }, [isMobile])

  // Clear any pending hide timeout
  const clearHideTimeout = useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current)
      hideTimeoutRef.current = null
    }
  }, [])

  // Show preview (only from collapsed state)
  const showPreview = useCallback(() => {
    clearHideTimeout()
    // Dismiss mobile keyboard when opening sidebar
    if (isMobile && state === "collapsed" && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    setState((current) => {
      if (current === "collapsed") {
        return "preview"
      }
      return current
    })
  }, [clearHideTimeout, isMobile, state])

  // Hide preview after delay (returns to collapsed)
  const hidePreview = useCallback(() => {
    clearHideTimeout()
    hideTimeoutRef.current = setTimeout(() => {
      setState((current) => {
        if (current === "preview") {
          return "collapsed"
        }
        return current
      })
    }, HIDE_DELAY_MS)
  }, [clearHideTimeout])

  // Toggle between collapsed and pinned (or preview on mobile).
  // On desktop, toggling while in preview (hover) locks it to pinned instead
  // of collapsing — otherwise the active hover would immediately re-open
  // preview and the sidebar would appear to flicker.
  const togglePinned = useCallback(() => {
    clearHideTimeout()
    // Dismiss mobile keyboard when opening sidebar
    if (isMobile && state === "collapsed" && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    setState((current) => {
      let next: SidebarState
      if (current === "pinned") {
        next = "collapsed"
      } else if (current === "preview") {
        // Desktop: lock hover-preview as pinned. Mobile: preview acts as
        // "open", so toggling closes it.
        next = isMobile ? "collapsed" : "pinned"
      } else if (isMobile) {
        next = "preview"
      } else {
        next = "pinned"
      }
      // Persist the open state (not preview which is transient)
      if (!isMobile) {
        updatePersistedState({ openState: next === "pinned" ? "open" : "collapsed" })
      }
      return next
    })
  }, [clearHideTimeout, isMobile, state, updatePersistedState])

  // Collapse the sidebar (skip localStorage persist on mobile to preserve desktop preference)
  const collapse = useCallback(() => {
    clearHideTimeout()
    setState("collapsed")
    if (!isMobile) {
      updatePersistedState({ openState: "collapsed" })
    }
  }, [clearHideTimeout, isMobile, updatePersistedState])

  // Collapse only when on mobile — safe to call unconditionally from click handlers
  const collapseOnMobile = useCallback(() => {
    if (isMobile) collapse()
  }, [isMobile, collapse])

  // Track hovering state (don't hide when resizing or menu is open)
  const setHovering = useCallback(
    (hovering: boolean) => {
      setIsHovering(hovering)
      isHoveringRef.current = hovering
      if (hovering) {
        showPreview()
      } else if (!isResizing && menuOpenCountRef.current === 0) {
        hidePreview()
      }
    },
    [showPreview, hidePreview, isResizing]
  )

  // Track open menus inside the sidebar (dropdowns render in portals outside the sidebar DOM,
  // so mouse-leaving the sidebar while a menu is open should NOT collapse it)
  const setMenuOpen = useCallback(
    (open: boolean) => {
      menuOpenCountRef.current = Math.max(0, menuOpenCountRef.current + (open ? 1 : -1))
      if (!open && menuOpenCountRef.current === 0 && !isHoveringRef.current) {
        hidePreview()
      }
    },
    [hidePreview]
  )

  // Resize functions
  const startResizing = useCallback(() => {
    setIsResizing(true)
  }, [])

  const stopResizing = useCallback(() => {
    setIsResizing(false)
  }, [])

  const setWidth = useCallback(
    (newWidth: number) => {
      // Resize-to-minimize: if dragged small enough, collapse instead
      const collapseThreshold = MIN_SIDEBAR_WIDTH - 50

      // If dragging back up from collapsed state, re-expand
      setState((currentState) => {
        if (currentState === "collapsed" && newWidth >= MIN_SIDEBAR_WIDTH) {
          updatePersistedState({ openState: "open" })
          return "pinned"
        }
        if (currentState !== "collapsed" && newWidth < collapseThreshold) {
          updatePersistedState({ openState: "collapsed" })
          return "collapsed"
        }
        return currentState
      })

      // Update width if above minimum
      if (newWidth >= MIN_SIDEBAR_WIDTH) {
        const clampedWidth = Math.min(MAX_SIDEBAR_WIDTH, newWidth)
        updatePersistedState({ width: clampedWidth })
      }
    },
    [updatePersistedState]
  )

  const getSectionState = useCallback(
    (section: string, defaultState: CollapseState = "open"): CollapseState => {
      return persistedState.sectionStates[section] ?? defaultState
    },
    [persistedState.sectionStates]
  )

  const toggleSectionState = useCallback(
    (section: string, defaultState: CollapseState = "open") => {
      setPersistedState((current) => {
        const fromState = current.sectionStates[section] ?? defaultState
        const next = {
          ...current,
          sectionStates: {
            ...current.sectionStates,
            [section]: fromState === "open" ? "collapsed" : "open",
          } satisfies Record<string, CollapseState>,
        }
        storeState(storageKey, next)
        return next
      })
    },
    [storageKey]
  )

  const setSectionState = useCallback(
    (section: string, state: CollapseState) => {
      setPersistedState((current) => {
        if (current.sectionStates[section] === state) return current
        const next = {
          ...current,
          sectionStates: { ...current.sectionStates, [section]: state },
        }
        storeState(storageKey, next)
        return next
      })
    },
    [storageKey]
  )

  // Urgency block registration for position-matched strip with fade transitions
  const setUrgencyBlock = useCallback((streamId: string, block: Omit<UrgencyBlock, "opacity"> | null) => {
    // Clear any existing fade-out timeout for this stream
    const existingTimeout = fadeOutTimeoutsRef.current.get(streamId)
    if (existingTimeout) {
      clearTimeout(existingTimeout)
      fadeOutTimeoutsRef.current.delete(streamId)
    }

    if (block === null) {
      // Fade out: set opacity to 0, then remove after transition
      setUrgencyBlocks((current) => {
        const existing = current.get(streamId)
        if (!existing) return current

        const next = new Map(current)
        next.set(streamId, { ...existing, opacity: 0 })
        return next
      })

      // Schedule removal after fade transition completes
      const timeout = setTimeout(() => {
        setUrgencyBlocks((current) => {
          const next = new Map(current)
          next.delete(streamId)
          return next
        })
        fadeOutTimeoutsRef.current.delete(streamId)
      }, 300)
      fadeOutTimeoutsRef.current.set(streamId, timeout)
    } else {
      // Fade in: set block with full opacity
      setUrgencyBlocks((current) => {
        const next = new Map(current)
        next.set(streamId, { ...block, opacity: 1 })
        return next
      })
    }
  }, [])

  const bumpScrollVersion = useCallback(() => setScrollVersion((v) => v + 1), [])

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current)
      }
      // Clean up all fade-out timeouts
      fadeOutTimeoutsRef.current.forEach((timeout) => clearTimeout(timeout))
      fadeOutTimeoutsRef.current.clear()
    }
  }, [])

  return (
    <SidebarContext.Provider
      value={{
        state,
        width: persistedState.width,
        sectionStates: persistedState.sectionStates,
        getSectionState,
        isMobile,
        isHovering,
        isResizing,
        urgencyBlocks,
        sidebarHeight,
        scrollContainerOffset,
        scrollVersion,
        showPreview,
        hidePreview,
        togglePinned,
        collapse,
        collapseOnMobile,
        setHovering,
        startResizing,
        stopResizing,
        setWidth,
        toggleSectionState,
        setSectionState,
        setUrgencyBlock,
        setSidebarHeight,
        setScrollContainerOffset,
        bumpScrollVersion,
        setMenuOpen,
      }}
    >
      {children}
    </SidebarContext.Provider>
  )
}

export function useSidebar() {
  const context = useContext(SidebarContext)
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider")
  }
  return context
}

export type { UrgencyBlock, CollapseState }
