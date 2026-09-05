import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"
import { StreamContent } from "@/components/timeline"
import { StreamErrorBoundary } from "@/components/stream-error-boundary"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { useStreamName } from "@/hooks/use-stream-name"
import { ASIDE_STAGE_MIN_WIDTH, closeAside, setAsideStageWidth, useAsideStageWidth } from "@/stores/aside-store"
import { useResizeDrag } from "@/hooks/use-resize-drag"
import { PanelResizeHandle } from "@/components/layout"
import { PanelHost } from "@/components/layout/panel-host"
import { usePanel } from "@/contexts"
import { streamFallbackLabel, streamLabel } from "@/lib/streams"
import { StreamTypes } from "@threa/types"
import { cn } from "@/lib/utils"
import { AsideAnchorLine } from "./aside-anchor-line"
import { AsideConversation } from "./aside-conversation"
import { AsideDrafts } from "./aside-drafts"
import { ASIDE_META, ASIDE_PANE, ASIDE_PANE_HEAD, AsideGlyph, AsidePrivateBadge } from "./aside-chrome"
import { AsideSplitHandle } from "./aside-split-handle"
import { useAsideDraftSurface } from "./use-aside-draft-surface"
import { useAsideSplit } from "./use-aside-split"
import { useAsideDrafts } from "./use-aside-drafts"

/** What the host pane keeps: below this it stops being readable as the thing
 *  you are answering, which is the only reason it is on the stage. */
const MIN_HOST_WIDTH = 420
/** The stage's own horizontal chrome, which neither pane gets: `p-3` either
 *  side, the two `gap-1` gutters, and the divider. Counted so the host really
 *  keeps `MIN_HOST_WIDTH` at the aside's widest, not that minus the furniture. */
const STAGE_CHROME_WIDTH = 24 + 8 + 1

interface AsideStageProps {
  workspaceId: string
  asideId: string
  hostStreamId: string
  originScope: string
}

/**
 * The aside's surface: it takes the content region, and the host stream comes
 * with it. Left is the real timeline — live, scrollable, and writable, because
 * a quick line into the channel should not cost you the aside. Right is the
 * aside itself, drafts over conversation, and the divider between them is
 * dragged. The page mounts no timeline of its own while this stands, so there
 * is exactly one host timeline on screen.
 */
export function AsideStage({ workspaceId, asideId, hostStreamId, originScope }: AsideStageProps) {
  const draftSurface = useAsideDraftSurface({ workspaceId, asideId, hostStreamId, originScope })
  // The right column stacks with `gap-3` and the divider between the halves, so
  // the conversation's floor is measured against what is left after that
  // furniture, not the column's whole height.
  const split = useAsideSplit(asideId, { reservedHeight: 12 + 12 + 1 })
  const streams = useWorkspaceStreams(workspaceId)
  const aside = useMemo(() => streams.find((stream) => stream.id === asideId), [streams, asideId])
  const host = useMemo(() => streams.find((stream) => stream.id === hostStreamId), [streams, hostStreamId])
  const hostName = useStreamName(workspaceId, hostStreamId, "breadcrumb")
  const title = aside ? streamLabel(aside) : streamFallbackLabel(StreamTypes.ASIDE, "generic")
  const drafts = useAsideDrafts(workspaceId, asideId)
  // The anchor line jumps by `?m=`, and while the stage stands this pane is the
  // only host timeline mounted — so it is the one that has to hear it. Only the
  // URL feeds this: standing in the aside's anchor would keep a deep link
  // permanently "active", and `StreamContent` clears a landed one three seconds
  // later, re-claiming the navigation and yanking the reader back every time.
  const [searchParams] = useSearchParams()
  // A thread opened from the host pane takes the pane. The page's own slot
  // shows nothing while the stage stands (stream.tsx, board.tsx), so this is
  // the thread's only mount, and the panel's close hands the pane back. An
  // aside opened from inside a thread has that thread as its host, and the
  // host view already shows it — a panel on top would be two chromes for one
  // stream.
  const { panelId, closePanel } = usePanel()
  const threadInPane = panelId !== null && panelId !== hostStreamId
  // Closing the thread means back to the host, so its composer takes focus on
  // the hand-back (the page does the same for main when a panel closes);
  // otherwise the next keystroke routes to the only other panel zone, the
  // aside column.
  const [hostTakesFocus, setHostTakesFocus] = useState(false)
  useEffect(() => {
    if (threadInPane) setHostTakesFocus(true)
  }, [threadInPane])

  // The stage's own width, so the divider can be capped against what is on
  // screen rather than the viewport.
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageWidth, setStageWidth] = useState(0)
  useLayoutEffect(() => {
    const element = stageRef.current
    if (!element) return
    const measure = () => setStageWidth(element.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const storedWidth = useAsideStageWidth(asideId)
  // Before the first measurement the viewport stands in — capping at the
  // stored width would make the divider inert on the frame it is grabbed.
  const measured = stageWidth > 0 ? stageWidth : (globalThis.window?.innerWidth ?? 0)
  const maxWidth = Math.max(ASIDE_STAGE_MIN_WIDTH, measured - MIN_HOST_WIDTH - STAGE_CHROME_WIDTH)
  const columnWidth = Math.min(Math.max(storedWidth, ASIDE_STAGE_MIN_WIDTH), maxWidth)
  const applyWidth = useCallback(
    (next: number) => setAsideStageWidth(asideId, Math.min(Math.max(next, ASIDE_STAGE_MIN_WIDTH), maxWidth)),
    [asideId, maxWidth]
  )
  const { isResizing, handleResizeStart, handleResizeMove, handleResizeEnd } = useResizeDrag({
    width: columnWidth,
    onWidthChange: applyWidth,
    direction: "left",
  })
  const onDividerKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const step = event.shiftKey ? 50 : 10
      if (event.key === "ArrowLeft") {
        event.preventDefault()
        applyWidth(columnWidth + step)
      } else if (event.key === "ArrowRight") {
        event.preventDefault()
        applyWidth(columnWidth - step)
      }
    },
    [applyWidth, columnWidth]
  )

  return (
    <div
      data-testid="aside-stage"
      data-aside-id={asideId}
      className="absolute inset-0 z-30 flex flex-col bg-background"
    >
      <TooltipProvider delayDuration={300}>
        <header className="flex h-12 shrink-0 items-center gap-2.5 border-b bg-background px-4">
          <AsideGlyph className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <h2 className="min-w-0 truncate text-[13px] font-semibold tracking-tight">{title}</h2>
          <AsidePrivateBadge />
          <AsideAnchorLine
            workspaceId={workspaceId}
            hostStreamId={hostStreamId}
            anchorId={aside?.parentAnchorId}
            variant="chip"
          />
          <span className="flex-1" />
          {drafts.length > 0 && (
            <span className={ASIDE_META}>
              {drafts.length} {drafts.length === 1 ? "draft" : "drafts"}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            aria-label="Close aside"
            onClick={closeAside}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </header>
      </TooltipProvider>

      <div ref={stageRef} className="flex min-h-0 flex-1 gap-1 bg-muted/40 p-3">
        {/* The two panes carry the app's editor zones rather than one of their
            own: type-to-focus and the composer's height observer both route by
            zone, and a zone they do not know is a zone they ignore. */}
        {threadInPane ? (
          <div data-testid="aside-host-pane" data-view="panel" className={cn(ASIDE_PANE, "min-w-0 flex-1")}>
            <PanelHost workspaceId={workspaceId} onClose={closePanel} className="bg-card sm:border-l-0" />
          </div>
        ) : (
          <div
            data-testid="aside-host-pane"
            data-view="host"
            data-editor-zone="main"
            className={cn(ASIDE_PANE, "min-w-0 flex-1")}
          >
            <div className={ASIDE_PANE_HEAD}>
              <span className="min-w-0 truncate font-medium text-foreground">{hostName ?? "Conversation"}</span>
            </div>
            <div className="relative min-h-0 flex-1">
              <StreamErrorBoundary streamId={hostStreamId}>
                <StreamContent
                  workspaceId={workspaceId}
                  streamId={hostStreamId}
                  stream={host}
                  highlightMessageId={searchParams.get("m")}
                  autoFocus={hostTakesFocus}
                />
              </StreamErrorBoundary>
            </div>
          </div>
        )}

        <PanelResizeHandle
          isResizing={isResizing}
          panelWidth={columnWidth}
          minWidth={ASIDE_STAGE_MIN_WIDTH}
          maxWidth={maxWidth}
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerEnd={handleResizeEnd}
          onKeyDown={onDividerKeyDown}
          ariaLabel="Resize aside"
        />

        <div
          ref={split.containerRef}
          data-editor-zone="panel"
          className="flex min-h-0 min-w-0 shrink-0 flex-col gap-3"
          style={{ width: columnWidth }}
        >
          <AsideDrafts
            workspaceId={workspaceId}
            asideId={asideId}
            surface={draftSurface}
            className={cn(ASIDE_PANE, "shrink-0")}
            style={draftSurface.openScope ? { height: split.height } : undefined}
          />
          {draftSurface.openScope && <AsideSplitHandle split={split} />}
          <div className={cn(ASIDE_PANE, "min-h-0 flex-1")}>
            <div className={ASIDE_PANE_HEAD}>
              <AsideGlyph className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
              <span className="font-medium text-foreground">Conversation</span>
            </div>
            <div className="relative min-h-0 flex-1">
              <AsideConversation
                workspaceId={workspaceId}
                asideId={asideId}
                aside={aside}
                autoFocus={!draftSurface.openScope}
                onInsertAgentBlock={draftSurface.insertAgentBlock}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
