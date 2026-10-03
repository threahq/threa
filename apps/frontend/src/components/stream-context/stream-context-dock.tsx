import { createContext, useContext, useState, type RefObject } from "react"
import { ThreadPanelSlot } from "@/components/layout/thread-panel-slot"
import { usePanelLayout } from "@/hooks/use-panel-layout"

interface StreamContextDockTarget {
  target: HTMLElement | null
}

const StreamContextDockContext = createContext<StreamContextDockTarget | null>(null)

export const StreamContextDockProvider = StreamContextDockContext.Provider

/**
 * The desktop column "In this stream" renders into, or null where the view has
 * none (an aside stage, the persona editor) — the overview is then not offered.
 */
export function useStreamContextDock(): StreamContextDockTarget | null {
  return useContext(StreamContextDockContext)
}

/**
 * Width lifecycle of the right-edge column that holds the desktop overview,
 * beside whatever the page's thread slot shows. `reservedWidth` is that slot's
 * width, so the two never crush the main column between them.
 */
export function useStreamContextDockLayout(
  containerRef: RefObject<HTMLDivElement | null>,
  open: boolean,
  reservedWidth: number
) {
  const layout = usePanelLayout(open, { containerRef, reservedWidth })
  const [target, setTarget] = useState<HTMLDivElement | null>(null)
  return { layout, target, setTarget }
}

export type StreamContextDockLayout = ReturnType<typeof useStreamContextDockLayout>

export function StreamContextDockSlot({
  dock,
  insetRight,
  inert,
}: {
  dock: StreamContextDockLayout
  insetRight: number
  inert?: boolean
}) {
  const { layout } = dock
  return (
    <ThreadPanelSlot
      testId="stream-context-dock"
      resizeLabel="Resize In this stream"
      displayWidth={layout.displayWidth}
      panelWidth={layout.panelWidth}
      shouldAnimate={layout.shouldAnimate}
      showContent={layout.showContent}
      isResizing={layout.isResizing}
      minWidth={layout.minWidth}
      maxWidth={layout.maxWidth}
      onTransitionEnd={layout.handleTransitionEnd}
      onResizeStart={layout.handleResizeStart}
      onResizeMove={layout.handleResizeMove}
      onResizeEnd={layout.handleResizeEnd}
      onResizeKeyDown={layout.handleResizeKeyDown}
      insetRight={insetRight}
      inert={inert}
    >
      <div ref={dock.setTarget} className="flex h-full min-h-0 flex-col bg-background" />
    </ThreadPanelSlot>
  )
}
