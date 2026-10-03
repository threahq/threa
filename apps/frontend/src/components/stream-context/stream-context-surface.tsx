import { useEffect, useRef, type CSSProperties, type RefObject, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer"
import { useSidebar } from "@/contexts"
import { cn } from "@/lib/utils"
import type { StreamContextPanelProps } from "./stream-context-chrome"
import { useStreamContextDock } from "./stream-context-dock"
import { StreamContextIndexPanel } from "./stream-context-index-panel"

interface StreamContextSurfaceProps {
  workspaceId: string
  streamId: string
  open: boolean
  onClose: () => void
  onJumpToMessage: StreamContextPanelProps["onJumpToMessage"]
  onOpenThread: (threadId: string) => void
  onOpenMemo: (memoId: string) => void
  onOpenGallery: (key: string) => void
}

/**
 * Hosts the "In this stream" overview: the page's docked right-edge column on
 * desktop, beside the stream it lists; a panel floating over the stream's
 * top-right corner where that column doesn't fit; a bottom drawer on mobile.
 * The same {@link StreamContextIndexPanel} renders inside each.
 */
export function StreamContextSurface(props: StreamContextSurfaceProps) {
  const { isMobile } = useSidebar()
  const dock = useStreamContextDock()
  const { open, onClose } = props
  // One focus session per open, shared by the docked and floating regions: the
  // first to mount takes focus and remembers the opener, a swap between them
  // (crossing the fit width) leaves focus where it is unless it was inside the
  // region that left. Closing returns it to the opener unless the user already
  // moved it somewhere else.
  const focusSession = useRef<FocusSession | null>(null)
  useEffect(() => {
    if (open) return
    const session = focusSession.current
    focusSession.current = null
    if (document.activeElement === document.body) session?.opener?.focus({ preventScroll: true })
  }, [open])

  const panel = (
    <StreamContextIndexPanel
      workspaceId={props.workspaceId}
      streamId={props.streamId}
      onClose={onClose}
      onJumpToMessage={props.onJumpToMessage}
      onOpenThread={props.onOpenThread}
      onOpenMemo={props.onOpenMemo}
      onOpenGallery={props.onOpenGallery}
    />
  )

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={(next) => !next && onClose()}>
        <DrawerContent className="h-[88dvh]">
          <DrawerTitle className="sr-only">In this stream</DrawerTitle>
          <DrawerDescription className="sr-only">
            Links, files, images, captured memories, and delegated tasks from this conversation.
          </DrawerDescription>
          <div className="flex min-h-0 flex-1 flex-col">{panel}</div>
        </DrawerContent>
      </Drawer>
    )
  }

  if (!open || !dock) return null
  // Without room for the column, the stream showing this overview owns the
  // window's right edge (the dock is closed), and its header is h-12 on the
  // page and the panel alike.
  if (!dock.fits) {
    return createPortal(
      <OverviewRegion
        onClose={onClose}
        focusSession={focusSession}
        // A side-docked call takes the window's right edge first.
        style={{ right: "calc(0.5rem + var(--call-dock-inset-right, 0px))" }}
        className="fixed bottom-2 top-14 z-30 w-96 max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-border/60 bg-background shadow-lg animate-in fade-in-0 slide-in-from-top-1"
      >
        {panel}
      </OverviewRegion>,
      document.body
    )
  }
  if (!dock.target) return null
  return createPortal(
    <OverviewRegion onClose={onClose} focusSession={focusSession} className="flex-1">
      {panel}
    </OverviewRegion>,
    dock.target
  )
}

interface FocusSession {
  opener: HTMLElement | null
}

function OverviewRegion({
  onClose,
  focusSession,
  className,
  style,
  children,
}: {
  onClose: () => void
  focusSession: RefObject<FocusSession | null>
  className: string
  style?: CSSProperties
  children: ReactNode
}) {
  const ref = useRef<HTMLElement>(null)

  // Focus comes in on open so Escape reaches the overview. A StrictMode rerun
  // finds the session already started and focus inside, and leaves both.
  useEffect(() => {
    const active = document.activeElement
    if (!focusSession.current) {
      focusSession.current = { opener: active instanceof HTMLElement ? active : null }
      ref.current?.focus({ preventScroll: true })
    } else if (active === document.body) {
      ref.current?.focus({ preventScroll: true })
    }
  }, [focusSession])

  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-label="In this stream"
      className={cn("flex min-h-0 flex-col outline-none", className)}
      style={style}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return
        // Claims the key so the stream's window-level Escape doesn't also settle it.
        e.preventDefault()
        onClose()
      }}
    >
      {children}
    </aside>
  )
}
