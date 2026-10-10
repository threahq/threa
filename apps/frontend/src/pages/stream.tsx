import { useState, useRef, useEffect } from "react"
import { useParams } from "react-router-dom"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { floatingPanelTab, primaryPanelOf, type PaneEdge } from "@/lib/panel-tabs"
import { useStreamOrDraft, useStreamError, usePanelLayout, useTypeToFocus } from "@/hooks"
import { usePanel, useSidebar } from "@/contexts"
import { ResizablePanelFrame, usePanelInset } from "@/components/layout"
import { PaneHost, Pane, PaneDropContext, PaneDropIndicator, paneDropZone, usePaneDropState } from "@/components/panes"
import { StreamPane, useConversationViewParam } from "@/components/panes/stream-pane"
import {
  AsideColumn,
  AsideCoversPanesContext,
  AsideMobileSheet,
  asideColumnFits,
  useAsideColumnLayout,
  useAsideHost,
  useAsideIsSheet,
} from "@/components/aside"
import { asideHoldsPanel, useAsideForHost } from "@/stores/aside-store"
import { PaneDrawer, PanelTabStack, useFittedPanelLayout } from "@/components/layout/panel-host"
import { PaneShortcuts } from "@/components/layout/pane-shortcuts"
import { ConversationList } from "@/components/conversations"
import { StreamErrorView } from "@/components/stream-error-view"
import { StreamTypes } from "@threahq/types"
import { getStreamName } from "@/lib/streams"
import { MIN_PANEL_WIDTH } from "@/hooks/use-panel-layout"
import { useElementWidth } from "@/hooks/use-element-width"
import { setPageStreamName } from "@/lib/page-title"

const MAIN_DROP_EDGES: readonly PaneEdge[] = ["right"]

export function StreamPage() {
  const { workspaceId, streamId } = useParams<{ workspaceId: string; streamId: string }>()
  const { stream, error } = useStreamOrDraft(workspaceId!, streamId!)
  const { isMobile } = useSidebar()
  const { panelId, isPanelOpen, layout, setCurrentPane } = usePanel()
  const containerRef = useRef<HTMLDivElement>(null)
  const mainPaneRef = useRef<HTMLDivElement>(null)
  const containerWidth = useElementWidth(containerRef)
  const asideHostKey = useAsideHost()
  // A sheet over the page on a phone, or where the columns leave it no room; anywhere else a column of it.
  const asideSheetOnly = useAsideIsSheet()
  const asideIsSheet = asideSheetOnly || !asideColumnFits(containerWidth, isPanelOpen ? MIN_PANEL_WIDTH : 0)
  const openAside = useAsideForHost(asideHostKey)
  const asideColumn = asideIsSheet ? null : openAside
  // A phone's pages, without the drawers over them; the one on show, null for the main view.
  const phonePages = useFittedPanelLayout(1, true)
  const pagePanel = isMobile ? primaryPanelOf(phonePages) : panelId
  // A thread the sheet holds is mounted there and nowhere else: not in the
  // slot, not as the phone's takeover behind the sheet. The sheet holds the
  // primary pane (aside-mobile-sheet.tsx), so this reads the same one.
  const panelInAside = asideIsSheet && openAside !== null && asideHoldsPanel(panelId, openAside.hostStreamId)
  // The aside clamps against the other columns' minimums.
  const asideLayout = useAsideColumnLayout(asideColumn, containerWidth, isPanelOpen ? MIN_PANEL_WIDTH : 0)
  const {
    panelWidth,
    maxWidth,
    minWidth,
    displayWidth,
    shouldAnimate,
    isResizing,
    showContent,
    handleResizeStart,
    handleResizeMove,
    handleResizeEnd,
    handleResizeKeyDown,
    handleTransitionEnd,
    maxColumns,
  } = usePanelLayout(isPanelOpen && !panelInAside, {
    containerRef,
    columns: layout.columns.length,
    reservedWidth: asideLayout.width,
    animates: !isMobile,
  })
  const fittedPanels = useFittedPanelLayout(maxColumns, false)
  const paneDrops = usePaneDropState(workspaceId!, streamId!)

  useTypeToFocus()

  // Unified error checking - checks both coordinated loading and direct query errors
  const streamError = useStreamError(streamId, error)

  const panelInset = displayWidth + asideLayout.width
  const panelInsetAnimates = shouldAnimate && !asideLayout.isResizing
  // Above the error/early returns: a stream that turns inaccessible mid-session
  // must not change this component's hook count.
  usePanelInset(isMobile || streamError ? 0 : panelInset, panelInsetAnimates)

  const [isConversationViewOpen, setConversationViewOpen] = useConversationViewParam()
  // The closed drawer stays in the DOM for its slide transition, but its list
  // re-renders on every conversation update, so it mounts only while shown.
  const [conversationListMounted, setConversationListMounted] = useState(isConversationViewOpen)
  if (isConversationViewOpen && !conversationListMounted) setConversationListMounted(true)

  const isChannel = stream?.type === StreamTypes.CHANNEL
  const isDm = stream?.type === StreamTypes.DM

  // `stream.displayName` is already viewer-resolved by useStreamOrDraft (DM peer
  // names included), so the page title just reads the shared name off it.
  useEffect(() => {
    if (!stream) {
      setPageStreamName(null)
      return () => setPageStreamName(null)
    }
    setPageStreamName(getStreamName(stream))
    return () => setPageStreamName(null)
  }, [stream])

  if (!workspaceId || !streamId) {
    return null
  }

  // Show error page if stream has error (404/403)
  if (streamError) {
    return <StreamErrorView type={streamError.type} workspaceId={workspaceId} />
  }

  // Conversation side panel - shown for channels and DMs
  const conversationPanel = (isChannel || isDm) && (
    <>
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/80 transition-opacity duration-300",
          isConversationViewOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        onClick={() => setConversationViewOpen(false)}
      />
      <div
        className={cn(
          "fixed inset-y-0 right-0 z-50 w-full sm:w-96 bg-background border-l shadow-lg flex flex-col",
          "transition-transform duration-300 ease-out",
          isConversationViewOpen ? "translate-x-0" : "translate-x-full"
        )}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && !isConversationViewOpen) setConversationListMounted(false)
        }}
      >
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">Conversations</h2>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setConversationViewOpen(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {conversationListMounted && (
            <ConversationList
              workspaceId={workspaceId}
              streamId={streamId}
              onMessageClick={() => setConversationViewOpen(false)}
            />
          )}
        </div>
      </div>
    </>
  )

  // On mobile the panel takes over the full screen, but the timeline stays mounted
  // behind it so closing a thread lands back where the reader was rather than
  // re-running the opening scroll.
  const mobileTakeover = isMobile && pagePanel !== null && !panelInAside
  const tabStackShown = isMobile ? mobileTakeover : showContent && !panelInAside
  // A tab floating over the page leaves everything else under it out of reach.
  const floating = tabStackShown && floatingPanelTab(layout, isMobile) !== null

  const drops = isMobile || floating || panelInAside ? null : paneDrops
  // Main's right edge opens a first column; its centre and left edge wait for main to be a pane.
  const mainDropZone =
    layout.columns.length < maxColumns ? paneDropZone(drops, null, MAIN_DROP_EDGES, false) : undefined

  return (
    <AsideCoversPanesContext.Provider value={asideIsSheet && openAside !== null}>
      <PaneHost
        ref={containerRef}
        columns={isMobile ? "minmax(0,1fr)" : `minmax(0,1fr) ${displayWidth}px ${asideLayout.width}px`}
        animate={shouldAnimate && !isMobile && !asideLayout.isResizing}
        onTransitionEnd={handleTransitionEnd}
      >
        {/* Drops reach the page's own panes only: never the aside's, nor a drawer's. */}
        <PaneDropContext.Provider value={drops}>
          <Pane
            area="1 / 1"
            covered={mobileTakeover}
            inert={floating}
            className={cn(floating && "isolate")}
            ref={mainPaneRef}
            data-testid="main-pane"
            onPointerDownCapture={() => setCurrentPane(null)}
            onFocusCapture={() => setCurrentPane(null)}
            {...mainDropZone}
          >
            <StreamPane
              workspaceId={workspaceId}
              streamId={streamId}
              contextLayout={isMobile ? phonePages : fittedPanels}
            />
          </Pane>
          <PaneDropIndicator of={null} area="1 / 1" />
          <Pane
            area={isMobile ? "1 / 1" : "1 / 2"}
            // An empty pane over the timeline's cell would still take its taps.
            covered={isMobile && !mobileTakeover}
            data-testid="panel"
            className="bg-background"
          >
            {tabStackShown && (
              <ResizablePanelFrame
                fill={isMobile}
                panelWidth={panelWidth}
                isResizing={isResizing}
                minWidth={minWidth}
                maxWidth={maxWidth}
                onResizeStart={handleResizeStart}
                onResizeMove={handleResizeMove}
                onResizeEnd={handleResizeEnd}
                onResizeKeyDown={handleResizeKeyDown}
                handleInert={floating}
              >
                <PanelTabStack
                  workspaceId={workspaceId}
                  maxColumns={maxColumns}
                  stacked={isMobile}
                  main={mainPaneRef}
                />
              </ResizablePanelFrame>
            )}
          </Pane>
        </PaneDropContext.Provider>
        {/* The tab stack takes the shortcuts over once it mounts, which trails the panel opening. */}
        {(!isPanelOpen || !(tabStackShown || panelInAside)) && <PaneShortcuts />}
        {asideColumn && (
          <Pane area="1 / 3" inert={floating} className={cn(floating && "isolate")}>
            <AsideColumn workspaceId={workspaceId} aside={asideColumn} layout={asideLayout} />
          </Pane>
        )}
        {/* One drawer at a time: the aside's sheet holds the page under the overview's. */}
        {isMobile && !(asideIsSheet && openAside) && <PaneDrawer workspaceId={workspaceId} page={pagePanel} />}
        {asideIsSheet && openAside && (
          <AsideMobileSheet
            workspaceId={workspaceId}
            asideId={openAside.asideId}
            hostStreamId={openAside.hostStreamId}
            originScope={openAside.originScope}
            historyEntry={asideSheetOnly}
          />
        )}
      </PaneHost>
      {/* A `fixed` overlay that would paint over a fullscreen panel, so a takeover
          keeps it out of the tree entirely rather than merely closed. Its
          `?convView` state survives in the URL and returns when the panel closes. */}
      {!mobileTakeover && conversationPanel}
    </AsideCoversPanesContext.Provider>
  )
}
