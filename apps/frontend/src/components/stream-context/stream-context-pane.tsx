import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import { SidePanel, SidePanelClose, SidePanelHeader, SidePanelTitle } from "@/components/ui/side-panel"
import { PaneFocusToggle, PanelTabStrip, PanelTabTitle, usePanelCloseFocusLanding } from "@/components/panes"
import {
  createContextPanelId,
  parseContextPanel,
  useCurrentPane,
  useDisplayedPanelLayout,
  useInPaneDrawer,
  usePanel,
  useSidebar,
} from "@/contexts"
import { memoDeepLink } from "@/lib/memo-url"
import { closePanelTab, formatPanelLayout, parsePanelLayout, PANEL_PARAM } from "@/lib/panel-tabs"
import { ContextCount, parseFilter, type Filter } from "./stream-context-chrome"
import { StreamContextGallery } from "./stream-context-gallery"
import { StreamContextIndexPanel } from "./stream-context-index-panel"
import { useStreamGallery } from "./use-stream-gallery"

interface StreamContextPaneProps {
  workspaceId: string
  streamId: string
  /** The category filter its id carries, or null for all. */
  filter: string | null
  onClose: () => void
  className?: string
}

/**
 * A stream's "In this stream" overview as a pane of its own
 * (`context:<streamId>[:<filter>]`), beside the stream it lists.
 */
export function StreamContextPane({ workspaceId, streamId, filter, onClose, className }: StreamContextPaneProps) {
  const { panelId, tabbed, openPanel, withPanelOpen, setCurrentPane } = usePanel()
  const { streamId: mainStreamId } = useParams<{ streamId: string }>()
  const [, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const { isMobile } = useSidebar()
  const inDrawer = useInPaneDrawer()
  const showTabs = tabbed && !inDrawer
  const closeRef = usePanelCloseFocusLanding()
  const gallery = useStreamGallery()
  const current = useCurrentPane()
  // The gallery opens from the overview worked in, else the first on show, so a reload keeps it open.
  // Only one drawer shows at a time, so it always owns it.
  const overviewsOnShow = useDisplayedPanelLayout()
    .columns.flat()
    .map((section) => section.active)
    .filter((id) => parseContextPanel(id) !== null)
  const galleryOwner = current !== null && overviewsOnShow.includes(current) ? current : (overviewsOnShow[0] ?? null)
  const ownsGallery = inDrawer || galleryOwner === panelId
  const active = parseFilter(filter)

  const changeFilter = (value: Filter) =>
    openPanel(createContextPanelId(streamId, value === "all" ? null : value), { replace: true })

  // One navigation shows the message where it lives: the main view, or its
  // stream's tab (a thread the overview found it in opens beside). A drawer
  // covers that view, so it closes in the same step and Back brings it back. A fresh push gives the `?m=` effect a new location key.
  const jumpToMessage = (messageId: string, inStreamId = streamId) => {
    const inMain = inStreamId === mainStreamId
    setSearchParams((prev) => {
      const next = inMain ? new URLSearchParams(prev) : withPanelOpen(prev, inStreamId)
      if (inDrawer && panelId) {
        const rest = formatPanelLayout(closePanelTab(parsePanelLayout(next.get(PANEL_PARAM)), panelId))
        if (rest === null) next.delete(PANEL_PARAM)
        else next.set(PANEL_PARAM, rest)
      }
      next.set("m", messageId)
      return next
    })
    setCurrentPane(inMain ? null : inStreamId)
  }

  return (
    <SidePanel className={className} data-editor-zone="panel" role="region" aria-label="In this stream">
      <StreamContextIndexPanel
        workspaceId={workspaceId}
        streamId={streamId}
        filter={active}
        onFilterChange={changeFilter}
        header={(total) => (
          <SidePanelHeader className="relative">
            {showTabs ? (
              <PanelTabStrip workspaceId={workspaceId} className="-ml-2" labels={<ContextCount total={total} />} />
            ) : (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <SidePanelTitle className="min-w-0">
                  <PanelTabTitle workspaceId={workspaceId} panelId={createContextPanelId(streamId)} />
                </SidePanelTitle>
                <ContextCount total={total} />
              </div>
            )}
            <PaneFocusToggle />
            {!isMobile && !showTabs && <SidePanelClose onClose={onClose} ref={closeRef} />}
          </SidePanelHeader>
        )}
        onJumpToMessage={jumpToMessage}
        onOpenThread={(threadId) => openPanel(threadId)}
        onOpenMemo={(memoId) => navigate(memoDeepLink(workspaceId, memoId))}
        onOpenGallery={gallery.openGallery}
      />
      {/* Only the pane worked in opens `?smedia=`, so two overviews never open it twice. */}
      {ownsGallery && (
        <StreamContextGallery
          workspaceId={workspaceId}
          streamId={streamId}
          selectedKey={gallery.selectedKey}
          onSelect={gallery.openGallery}
          onClose={gallery.closeGallery}
        />
      )}
    </SidePanel>
  )
}
