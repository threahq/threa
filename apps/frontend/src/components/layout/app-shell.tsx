import { type ReactNode, useCallback } from "react"
import { RefreshCw } from "lucide-react"
import { useSidebar, useCoordinatedLoading, type UrgencyBlock } from "@/contexts"
import { useResizeDrag, useVisualViewport, useSidebarSwipe, usePullToRefresh } from "@/hooks"
import { useSyncEngine } from "@/sync/sync-engine"
import { TopbarLoadingIndicator } from "./topbar-loading-indicator"
import { ConnectionStatus } from "./connection-status"
import { cn } from "@/lib/utils"

// Pull indicator styling per mode — INV-47
const pullModeConfig = {
  idle: { bg: "bg-muted/50", text: "text-muted-foreground", label: "Pull to refresh" },
  soft: { bg: "bg-muted/50", text: "text-muted-foreground", label: "Release to refresh" },
  hard: { bg: "bg-orange-500/15", text: "text-orange-500", label: "Release to reload" },
} as const

interface PullIndicatorProps {
  distance: number
  progress: number
  pulling: boolean
  refreshing: boolean
  mode: keyof typeof pullModeConfig
}

function PullIndicator({ distance, progress, pulling, refreshing, mode }: PullIndicatorProps) {
  if (distance <= 5) return null
  const config = pullModeConfig[mode]

  return (
    <>
      <div
        className={cn("flex items-center justify-center rounded-full", refreshing ? "bg-primary/10" : config.bg)}
        style={{
          width: `${28 + progress * 8}px`,
          height: `${28 + progress * 8}px`,
          transition: pulling ? "none" : "all 0.3s ease-out",
        }}
      >
        <RefreshCw
          className={cn("h-3.5 w-3.5", refreshing ? "text-primary animate-spin" : config.text)}
          style={
            refreshing
              ? undefined
              : {
                  opacity: 0.4 + progress * 0.6,
                  transform: `rotate(${progress * 270}deg) scale(${0.7 + progress * 0.3})`,
                }
          }
        />
      </div>
      <span
        className={cn("text-xs font-medium", config.text)}
        style={{
          opacity: 0.4 + progress * 0.6,
          transition: pulling ? "none" : "opacity 0.2s ease-out",
        }}
      >
        {config.label}
      </span>
    </>
  )
}

/**
 * Soft, position-matched urgency glow blocks. Each block is a single blurred
 * bar sized to its stream row (expanded 150% and centered) so the color diffuses
 * out as a glow rather than a hard bar. Shared by the desktop edge strip and the
 * mobile left-edge hint. The `position`/`height` fractions are measured against
 * the sidebar in `useUrgencyTracking`, so both surfaces render the same column.
 */
function UrgencyGlowBlocks({ blocks }: { blocks: Map<string, UrgencyBlock> }) {
  return (
    <>
      {Array.from(blocks.entries()).map(([streamId, block]) => {
        const expandedHeight = block.height * 1.5
        const centeredTop = block.position - block.height * 0.25
        return (
          <div
            key={streamId}
            className="absolute transition-opacity duration-300"
            style={{
              left: "-4px",
              width: "14px",
              top: `${centeredTop * 100}%`,
              height: `${Math.max(expandedHeight * 100, 4)}%`,
              backgroundColor: block.color,
              filter: "blur(12px)",
              opacity: block.opacity,
            }}
          />
        )
      })}
    </>
  )
}

interface AppShellProps {
  sidebar: ReactNode
  children: ReactNode
}

/**
 * Main application shell with collapsible sidebar.
 *
 * Sidebar states:
 * - collapsed: 6px color strip only, 30px hover margin for "magnetic" feel
 * - preview: user-defined width, positioned absolute, doesn't push content (hover state)
 * - pinned: user-defined width, positioned normal, pushes content
 */
export function AppShell({ sidebar, children }: AppShellProps) {
  const {
    state,
    width,
    isMobile,
    isResizing,
    urgencyBlocks,
    setHovering,
    collapse,
    showPreview,
    startResizing,
    stopResizing,
    setWidth,
  } = useSidebar()
  const { showLoadingIndicator } = useCoordinatedLoading()

  const { handleResizeStart } = useResizeDrag({
    width,
    onWidthChange: setWidth,
    direction: "right",
    onResizeStart: startResizing,
    onResizeEnd: stopResizing,
  })

  const isKeyboardOpen = useVisualViewport(isMobile)

  const syncEngine = useSyncEngine()

  // Workspace + stream bootstrap caches are primed by SyncEngine (not a React
  // Query observer), so invalidateQueries never triggers a refetch. Route the
  // refresh through the engine's reconnect-style bootstrap instead.
  const handleSoftRefresh = useCallback(async () => {
    await syncEngine.refreshAfterConnectivityResume()
  }, [syncEngine])

  // Light pull = soft refresh (re-fetch data), heavy pull = hard refresh (page reload)
  const {
    ref: pullRef,
    distance: pullDistance,
    progress: pullProgress,
    pulling,
    refreshing,
    mode: pullMode,
  } = usePullToRefresh({
    enabled: isMobile && !isKeyboardOpen,
    onRefresh: handleSoftRefresh,
  })

  const isCollapsed = state === "collapsed"
  const isPreview = state === "preview"
  const isOpen = state === "pinned" || isPreview
  let wrapperWidth = `${width}px`
  if (isMobile) {
    wrapperWidth = "0px"
  } else if (isCollapsed || isPreview) {
    wrapperWidth = "6px"
  }

  let sidebarWidth = `${width}px`
  if (isMobile) {
    sidebarWidth = "min(85vw, 320px)"
  } else if (isCollapsed) {
    sidebarWidth = "6px"
  }

  // Swipe gestures for mobile sidebar (open/close by dragging)
  // Use showPreview (idempotent) instead of togglePinned (a toggle) to avoid
  // double-call races on fast swipes collapsing the sidebar right after opening.
  const { isSwiping, sidebarRef, backdropRef } = useSidebarSwipe({
    isOpen,
    isMobile,
    onOpen: showPreview,
    onClose: collapse,
  })

  // Handle mouse enter on hover margin or sidebar (disabled on mobile - touch devices don't hover)
  const handleMouseEnter = useCallback(() => {
    if (!isMobile) {
      setHovering(true)
    }
  }, [setHovering, isMobile])

  // Handle mouse leave from sidebar
  const handleMouseLeave = useCallback(() => {
    if (!isMobile) {
      setHovering(false)
    }
  }, [setHovering, isMobile])

  // Close backdrop on mobile
  const handleBackdropClick = useCallback(() => {
    collapse()
  }, [collapse])

  // Derive mobile sidebar/backdrop classes outside JSX to avoid nested ternaries (INV-47)
  let backdropVisibility: string | undefined
  if (!isSwiping) {
    backdropVisibility = isOpen ? "opacity-100" : "opacity-0 pointer-events-none"
  }

  let sidebarTransform: string | undefined
  if (!isSwiping) {
    sidebarTransform = isOpen ? "translate-x-0" : "-translate-x-full"
  }

  return (
    <div className="flex w-screen flex-col overflow-hidden" style={{ height: "var(--viewport-height, 100dvh)" }}>
      {/* Pull-to-refresh container — pulling anywhere (sidebar or main content)
           translates the entire area uniformly */}
      <div ref={pullRef} className="relative flex flex-1 flex-col overflow-hidden">
        {/* Workspace-wide loading indicator — hairline along the bottom of the
             sidebar/page header row (h-12). Spans the full viewport so it links
             the two headers visually now that the top bar is gone. */}
        <div className="pointer-events-none absolute left-0 right-0 top-12 z-[55]">
          <TopbarLoadingIndicator visible={showLoadingIndicator} />
        </div>

        {/* Pull-to-refresh indicator */}
        <div
          className="absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-2 pointer-events-none"
          style={{ height: `${pullDistance}px` }}
        >
          <PullIndicator
            distance={pullDistance}
            progress={pullProgress}
            pulling={pulling}
            refreshing={refreshing}
            mode={pullMode}
          />
        </div>

        {/* Main area with sidebar and content — translates down during pull */}
        <div
          className="flex flex-1 overflow-hidden"
          style={{
            transform: `translateY(${pullDistance}px)`,
            transition: pulling ? "none" : "transform 0.3s ease-out",
          }}
        >
          {/* Top-edge fade — smooths the hard cutoff of sidebar glow and backdrop
               darkness where they meet the pull padding area above */}
          <div
            className="absolute inset-x-0 top-0 z-[60] pointer-events-none"
            style={{
              height: pullDistance > 0 ? `${Math.min(pullDistance * 0.5, 32)}px` : "0px",
              background: "linear-gradient(to bottom, hsl(var(--background)), transparent)",
              transition: pulling ? "none" : "height 0.3s ease-out",
            }}
          />

          {/* Mobile backdrop - always in DOM so swipe gestures can control opacity imperatively */}
          {isMobile && (
            <div
              ref={backdropRef}
              className={cn(
                "fixed inset-0 z-30 bg-black/50",
                !isSwiping && "transition-opacity duration-200",
                backdropVisibility
              )}
              onClick={!isSwiping ? handleBackdropClick : undefined}
              aria-hidden="true"
            />
          )}

          {/* Mobile urgency glow - the sidebar itself is off-screen, so this is the
               only at-a-glance hint that there's something worth opening it for.
               Sits below the backdrop (z-30) so it's covered once the drawer opens,
               and bleeds rightward into content (left edge clipped at the screen edge). */}
          {isMobile && !isOpen && (
            <div
              className="fixed left-0 top-0 z-20 h-full w-[6px] pointer-events-none"
              style={{ clipPath: "inset(-50px -50px -50px 0)" }}
              aria-hidden="true"
            >
              <UrgencyGlowBlocks blocks={urgencyBlocks} />
            </div>
          )}

          {/* Sidebar wrapper - handles positioning */}
          <div
            className={cn(
              "relative z-40 flex flex-shrink-0 flex-col",
              // Transitions - disable during resize for smooth dragging
              !isResizing && "transition-[width] duration-200 ease-out",
              // On mobile, sidebar is always overlay (no wrapper width)
              isMobile && "w-0"
            )}
            style={{
              width: wrapperWidth,
            }}
          >
            {/* Urgency strip - always visible on left edge (6px wide) */}
            {!isMobile && (
              <div
                className="absolute left-0 top-0 h-full w-[6px] z-50 pointer-events-none"
                style={{
                  // Clip right edge to prevent blur bleeding into sidebar/content
                  // Let blur extend left (off-screen), up, and down for soft glow
                  clipPath: "inset(-50px 0 -50px -50px)",
                }}
                aria-hidden="true"
              >
                {/* Grey baseline - always visible */}
                <div className="absolute inset-0" style={{ backgroundColor: "hsl(var(--muted-foreground) / 0.3)" }} />
                {/* Activity blocks - single blurred bar per stream, 150% height centered */}
                <UrgencyGlowBlocks blocks={urgencyBlocks} />
              </div>
            )}

            {/* Hover margin - invisible zone for "magnetic" feel (collapsed state only, not on mobile) */}
            {/* 30px zone to trigger preview when collapsed */}
            {isCollapsed && !isMobile && (
              <div
                className="absolute left-full top-0 z-30 h-full w-[30px]"
                onMouseEnter={handleMouseEnter}
                aria-hidden="true"
              />
            )}

            {/* Coyote Time zone - extends beyond sidebar in preview mode for comfortable resizing */}
            {/* Positioned outside aside (which has overflow-hidden) at sidebar's right edge */}
            {isPreview && !isMobile && (
              <div
                className="absolute top-0 z-50 h-full w-[30px]"
                style={{ left: `${width}px` }}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                aria-hidden="true"
              />
            )}

            {/* Sidebar container - clips content for reveal effect */}
            <aside
              ref={isMobile ? sidebarRef : undefined}
              className={cn(
                "relative flex h-full flex-col border-r bg-background overflow-hidden z-40",
                // Positioning - preview is absolute, or always absolute on mobile
                (isPreview || isMobile) && "absolute left-0 top-0",
                // Depth shadow only when the drawer is actually showing — on mobile the
                // closed drawer is off-screen and its right-edge shadow would otherwise
                // bleed onto the screen's left edge as a meaningless grey glow.
                (isPreview || (isMobile && isOpen)) && "shadow-[4px_0_24px_hsl(var(--foreground)/0.08)]",
                // Mobile: transform-based positioning (GPU-composited, swipe-compatible)
                isMobile && sidebarTransform,
                // Transitions - disable during resize/swipe for smooth dragging
                isMobile
                  ? !isSwiping && "transition-transform duration-200 ease-out"
                  : !isResizing && "transition-[width,box-shadow] duration-200 ease-out"
              )}
              style={{ width: sidebarWidth }}
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
              role="navigation"
              aria-label="Sidebar navigation"
            >
              {/* Inner container maintains full width for reveal animation (prevents text reflow) */}
              <div
                className="h-full flex-1 flex flex-col overflow-hidden"
                style={{
                  width: isMobile ? "min(85vw, 320px)" : `${width}px`,
                  minWidth: isMobile ? undefined : `${width}px`,
                }}
              >
                {sidebar}
              </div>

              {/* Resize handle - only visible when not collapsed and not on mobile */}
              {!isCollapsed && !isMobile && (
                <div
                  className={cn(
                    "absolute right-0 top-0 h-full w-1 cursor-col-resize",
                    "hover:bg-primary/20 active:bg-primary/30",
                    "transition-colors duration-150",
                    "focus-visible:bg-primary/30 focus-visible:outline-none",
                    isResizing && "bg-primary/30"
                  )}
                  onMouseDown={handleResizeStart}
                  onKeyDown={(e) => {
                    const step = e.shiftKey ? 50 : 10
                    if (e.key === "ArrowLeft") {
                      e.preventDefault()
                      setWidth(width - step)
                    } else if (e.key === "ArrowRight") {
                      e.preventDefault()
                      setWidth(width + step)
                    }
                  }}
                  tabIndex={0}
                  role="separator"
                  aria-orientation="vertical"
                  aria-valuenow={width}
                  aria-valuemin={200}
                  aria-valuemax={400}
                  aria-label="Resize sidebar"
                />
              )}
            </aside>
          </div>

          {/* Main content area — safe-area padding for notched devices when keyboard is closed */}
          <main
            className="relative flex flex-1 flex-col overflow-hidden"
            style={!isKeyboardOpen ? { paddingBottom: "env(safe-area-inset-bottom)" } : undefined}
          >
            <ConnectionStatus />
            {children}
          </main>
        </div>
      </div>
    </div>
  )
}
