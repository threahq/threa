import type { RefObject } from "react"
import type { CollapseState } from "@/contexts"
import { Button } from "@/components/ui/button"
import { SMART_SECTIONS } from "./config"
import { SmartSection, TieredStreamSection } from "./sections"
import type { SidebarActionItem } from "./sidebar-actions"
import type { StreamItemData } from "./types"

/** Default state of the "more" expander: collapsed so quiet tails stay hidden. */
const MORE_DEFAULT: CollapseState = "collapsed"

/** Key for the inline "more" expander of a parent section. */
function moreKey(parent: string): string {
  return `${parent}:more`
}

interface SidebarStreamListProps {
  workspaceId: string
  viewMode: "smart" | "all"
  isLoading: boolean
  hasError: boolean
  hasUserStreams: boolean
  activeStreamId?: string
  processedStreams: StreamItemData[]
  streamsBySection: {
    important: StreamItemData[]
    recent: StreamItemData[]
    pinned: StreamItemData[]
    other: StreamItemData[]
  }
  streamsByType: {
    scratchpads: StreamItemData[]
    channels: StreamItemData[]
    dms: StreamItemData[]
  }
  getUnreadCount: (streamId: string) => number
  getMentionCount: (streamId: string) => number
  getSectionState: (section: string, defaultState?: CollapseState) => CollapseState
  toggleSectionState: (section: string, defaultState?: CollapseState) => void
  onCreateScratchpad: () => void | Promise<void>
  onCreateChannel: () => void | Promise<void>
  /**
   * Dropdown actions for the Scratchpads "+" button. When provided, the button
   * opens this menu (Scratchpad / Quick Note / Encrypted Scratchpad) instead of
   * invoking `onCreateScratchpad` directly.
   */
  scratchpadAddMenuActions?: SidebarActionItem[]
  scrollContainerRef: RefObject<HTMLDivElement | null>
}

export function SidebarStreamList({
  workspaceId,
  viewMode,
  isLoading: _isLoading,
  hasError,
  hasUserStreams,
  activeStreamId,
  processedStreams,
  streamsBySection,
  streamsByType,
  getUnreadCount,
  getMentionCount,
  getSectionState,
  toggleSectionState,
  onCreateScratchpad,
  onCreateChannel,
  scratchpadAddMenuActions,
  scrollContainerRef,
}: SidebarStreamListProps) {
  if (hasError) {
    return <p className="px-2 py-4 text-xs text-destructive text-center">Failed to load</p>
  }

  if (!hasUserStreams) {
    return (
      <div className="px-4 py-8 text-center">
        <p className="text-sm text-muted-foreground mb-4">No streams yet</p>
        <Button variant="outline" size="sm" onClick={() => void onCreateScratchpad()} className="mr-2">
          + New Scratchpad
        </Button>
        <Button variant="outline" size="sm" onClick={() => void onCreateChannel()}>
          + New Channel
        </Button>
      </div>
    )
  }

  if (viewMode === "smart") {
    return (
      <>
        <SmartSection
          section="important"
          items={streamsBySection.important}
          allStreams={processedStreams}
          workspaceId={workspaceId}
          activeStreamId={activeStreamId}
          getUnreadCount={getUnreadCount}
          getMentionCount={getMentionCount}
          state={getSectionState("important")}
          onToggle={() => toggleSectionState("important")}
          scrollContainerRef={scrollContainerRef}
        />
        <SmartSection
          section="recent"
          items={streamsBySection.recent}
          allStreams={processedStreams}
          workspaceId={workspaceId}
          activeStreamId={activeStreamId}
          getUnreadCount={getUnreadCount}
          getMentionCount={getMentionCount}
          state={getSectionState("recent")}
          onToggle={() => toggleSectionState("recent")}
          scrollContainerRef={scrollContainerRef}
        />
        <SmartSection
          section="pinned"
          items={streamsBySection.pinned}
          allStreams={processedStreams}
          workspaceId={workspaceId}
          activeStreamId={activeStreamId}
          getUnreadCount={getUnreadCount}
          getMentionCount={getMentionCount}
          state={getSectionState("pinned")}
          onToggle={() => toggleSectionState("pinned")}
          scrollContainerRef={scrollContainerRef}
        />
        {streamsBySection.other.length > 0 && (
          <TieredStreamSection
            sectionKey="other"
            label={SMART_SECTIONS.other.label}
            icon={SMART_SECTIONS.other.icon}
            items={streamsBySection.other}
            allStreams={processedStreams}
            workspaceId={workspaceId}
            activeStreamId={activeStreamId}
            getUnreadCount={getUnreadCount}
            getMentionCount={getMentionCount}
            state={getSectionState("other", "collapsed")}
            onToggle={() => toggleSectionState("other", "collapsed")}
            moreState={getSectionState(moreKey("other"), MORE_DEFAULT)}
            onToggleMore={() => toggleSectionState(moreKey("other"), MORE_DEFAULT)}
            compact={SMART_SECTIONS.other.compact}
            showPreviewOnHover={SMART_SECTIONS.other.showPreviewOnHover}
            scrollContainerRef={scrollContainerRef}
          />
        )}
      </>
    )
  }

  return (
    <>
      <TieredStreamSection
        sectionKey="scratchpads"
        label="Scratchpads"
        items={streamsByType.scratchpads}
        allStreams={processedStreams}
        workspaceId={workspaceId}
        activeStreamId={activeStreamId}
        getUnreadCount={getUnreadCount}
        getMentionCount={getMentionCount}
        state={getSectionState("scratchpads")}
        onToggle={() => toggleSectionState("scratchpads")}
        moreState={getSectionState(moreKey("scratchpads"), MORE_DEFAULT)}
        onToggleMore={() => toggleSectionState(moreKey("scratchpads"), MORE_DEFAULT)}
        scrollContainerRef={scrollContainerRef}
        onAdd={() => void onCreateScratchpad()}
        addTooltip={scratchpadAddMenuActions ? "New scratchpad…" : "+ New Scratchpad"}
        addMenuActions={scratchpadAddMenuActions}
        compact
        showPreviewOnHover
      />

      <TieredStreamSection
        sectionKey="channels"
        label="Channels"
        items={streamsByType.channels}
        allStreams={processedStreams}
        workspaceId={workspaceId}
        activeStreamId={activeStreamId}
        getUnreadCount={getUnreadCount}
        getMentionCount={getMentionCount}
        state={getSectionState("channels")}
        onToggle={() => toggleSectionState("channels")}
        moreState={getSectionState(moreKey("channels"), MORE_DEFAULT)}
        onToggleMore={() => toggleSectionState(moreKey("channels"), MORE_DEFAULT)}
        scrollContainerRef={scrollContainerRef}
        onAdd={() => void onCreateChannel()}
        addTooltip="+ New Channel"
        compact
        showPreviewOnHover
      />

      {streamsByType.dms.length > 0 && (
        <TieredStreamSection
          sectionKey="dms"
          label="Direct Messages"
          items={streamsByType.dms}
          allStreams={processedStreams}
          workspaceId={workspaceId}
          activeStreamId={activeStreamId}
          getUnreadCount={getUnreadCount}
          getMentionCount={getMentionCount}
          state={getSectionState("dms")}
          onToggle={() => toggleSectionState("dms")}
          moreState={getSectionState(moreKey("dms"), MORE_DEFAULT)}
          onToggleMore={() => toggleSectionState(moreKey("dms"), MORE_DEFAULT)}
          scrollContainerRef={scrollContainerRef}
          compact
          showPreviewOnHover
        />
      )}
    </>
  )
}
