import { useMemo, useRef } from "react"
import { SidePanel, SidePanelTitle } from "@/components/ui/side-panel"
import { TooltipProvider } from "@/components/ui/tooltip"
import { PaneHeader, PanelTabTitle } from "@/components/panes"
import { createAsidePanelId, usePanel, useRevealReady } from "@/contexts"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { useAsideState } from "@/stores/aside-store"
import { useElementWidth } from "@/hooks/use-element-width"
import { foldHeaderControls, type FoldableControl } from "@/lib/pane-header-fold"
import { tabRowReserve } from "@/lib/panel-tab-fit"
import { cn } from "@/lib/utils"
import { AsideAnchorLine } from "./aside-anchor-line"
import { ASIDE_META, AsideGlyph, AsidePrivateBadge } from "./aside-chrome"
import { AsideConversation } from "./aside-conversation"
import { AsideDrafts } from "./aside-drafts"
import { AsideSplitHandle } from "./aside-split-handle"
import { useAsideDraftSurface } from "./use-aside-draft-surface"
import { useAsideDrafts } from "./use-aside-drafts"
import { useAsideSplit } from "./use-aside-split"

const HEADER_GAP = 10
const TITLE_GAP = 8
const PRIVATE_WIDTH = 68
const PRIVATE_LOCK_WIDTH = 24
const ANCHOR_GLYPH_WIDTH = 34
/** The anchor chip with the least of its name worth reading. */
const ANCHOR_MIN_WIDTH = 106
const DRAFT_COUNT_WIDTH = 56
/** The glyph and a few letters. */
const TITLE_MIN_WIDTH = 72

interface AsidePanelProps {
  workspaceId: string
  hostStreamId: string
  className?: string
}

/**
 * The aside open on a stream, as a pane beside it (`aside:<hostStreamId>`):
 * drafts over the conversation, the divider between them dragged. Which aside
 * lives in the aside store; a pane the store holds none for shows nothing until
 * the page drops it.
 */
export function AsidePanel({ workspaceId, hostStreamId, className }: AsidePanelProps) {
  const open = useAsideState()
  useRevealReady(true)
  if (open?.hostStreamId !== hostStreamId) return null
  return (
    <AsidePanelContent
      key={open.asideId}
      workspaceId={workspaceId}
      asideId={open.asideId}
      hostStreamId={hostStreamId}
      originScope={open.originScope}
      className={className}
    />
  )
}

function AsidePanelContent({
  workspaceId,
  asideId,
  hostStreamId,
  originScope,
  className,
}: AsidePanelProps & { asideId: string; originScope: string }) {
  const { tabbed, section } = usePanel()
  const draftSurface = useAsideDraftSurface({ workspaceId, asideId, hostStreamId, originScope })
  // The pane stacks the drafts, the divider and the conversation with no gutters, so only the divider is furniture.
  const split = useAsideSplit(asideId, { reservedHeight: 1 })
  const streams = useWorkspaceStreams(workspaceId)
  const aside = useMemo(() => streams.find((stream) => stream.id === asideId), [streams, asideId])
  const drafts = useAsideDrafts(workspaceId, asideId)

  const headerRef = useRef<HTMLElement>(null)
  const headerWidth = useElementWidth(headerRef)
  const leadingRef = useRef<HTMLDivElement>(null)
  const leadingWidth = useElementWidth(leadingRef)
  const trailingRef = useRef<HTMLDivElement>(null)
  const trailingWidth = useElementWidth(trailingRef)
  const edges =
    32 + (leadingWidth > 0 ? leadingWidth + HEADER_GAP : 0) + (trailingWidth > 0 ? trailingWidth + HEADER_GAP : 0)
  const draftCount: FoldableControl<"drafts" | "anchor" | "private">[] =
    drafts.length > 0 ? [{ id: "drafts", width: DRAFT_COUNT_WIDTH + HEADER_GAP }] : []
  // What goes first is what the pane repeats: the tray counts the drafts, and a tab row has the anchor on its own line.
  const folded = tabbed
    ? foldHeaderControls(headerWidth, edges, draftCount, tabRowReserve(section?.ids.length ?? 0))
    : foldHeaderControls(
        headerWidth,
        edges + PRIVATE_LOCK_WIDTH + ANCHOR_GLYPH_WIDTH + 2 * TITLE_GAP,
        [
          ...draftCount,
          { id: "anchor", width: ANCHOR_MIN_WIDTH - ANCHOR_GLYPH_WIDTH },
          { id: "private", width: PRIVATE_WIDTH - PRIVATE_LOCK_WIDTH },
        ],
        TITLE_MIN_WIDTH
      )

  return (
    <SidePanel className={className} data-testid="aside-panel" data-aside-id={asideId} data-editor-zone="panel">
      <TooltipProvider delayDuration={300}>
        <PaneHeader
          workspaceId={workspaceId}
          name="Aside"
          className="gap-2.5"
          closeLabel="Close aside"
          measureRefs={{ header: headerRef, leading: leadingRef, trailing: trailingRef }}
          title={
            <>
              <SidePanelTitle
                className={cn("flex items-center gap-2.5", folded.has("anchor") ? "min-w-0" : "shrink-0")}
                // The name's room beside it is the chip's to keep, so a long title stops short of it.
                style={
                  folded.has("anchor")
                    ? undefined
                    : { maxWidth: `min(50%, calc(100% - ${PRIVATE_WIDTH + ANCHOR_MIN_WIDTH + 2 * TITLE_GAP}px))` }
                }
              >
                <AsideGlyph className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 truncate text-[13px] font-semibold tracking-tight">
                  <PanelTabTitle workspaceId={workspaceId} panelId={createAsidePanelId(hostStreamId)} />
                </span>
              </SidePanelTitle>
              <AsidePrivateBadge compact={folded.has("private")} />
              <AsideAnchorLine
                workspaceId={workspaceId}
                hostStreamId={hostStreamId}
                anchorId={aside?.parentAnchorId}
                variant="chip"
                compact={folded.has("anchor")}
              />
            </>
          }
        >
          {drafts.length > 0 && !folded.has("drafts") && (
            <span className={ASIDE_META}>
              {drafts.length} {drafts.length === 1 ? "draft" : "drafts"}
            </span>
          )}
        </PaneHeader>
      </TooltipProvider>
      {tabbed && (
        <AsideAnchorLine workspaceId={workspaceId} hostStreamId={hostStreamId} anchorId={aside?.parentAnchorId} />
      )}
      <div ref={split.containerRef} className="flex min-h-0 flex-1 flex-col">
        <AsideDrafts
          workspaceId={workspaceId}
          asideId={asideId}
          surface={draftSurface}
          className={cn("shrink-0", !draftSurface.openScope && "border-b")}
          style={draftSurface.openScope ? { height: split.height } : undefined}
        />
        {draftSurface.openScope && <AsideSplitHandle split={split} />}
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
    </SidePanel>
  )
}
