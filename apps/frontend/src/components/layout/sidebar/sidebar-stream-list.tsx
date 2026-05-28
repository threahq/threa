import type { RefObject } from "react"
import type { CollapseState } from "@/contexts"
import { Button } from "@/components/ui/button"
import { StreamSection, TieredStreamSection } from "./sections"
import { sectionPresentation, type SidebarSectionSpec } from "./sidebar-config"
import type { ResolvedSection } from "./resolve-sections"
import type { SidebarActionItem } from "./sidebar-actions"
import type { StreamItemData } from "./types"

/** Default state of the "more" expander: collapsed so quiet tails stay hidden. */
const MORE_DEFAULT: CollapseState = "collapsed"

/** Key for the inline "more" expander of a parent section. */
function moreKey(parent: string): string {
  return `${parent}:more`
}

interface AddWiring {
  onAdd: () => void
  addTooltip: string
  addMenuActions?: SidebarActionItem[]
}

interface SidebarStreamListProps {
  workspaceId: string
  hasError: boolean
  hasUserStreams: boolean
  activeStreamId?: string
  /** All real streams — passed to each item for thread/preview lookups. */
  processedStreams: StreamItemData[]
  /** Ordered sections with their resolved, sorted, capped stream lists. */
  resolvedSections: ResolvedSection[]
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
  hasError,
  hasUserStreams,
  activeStreamId,
  processedStreams,
  resolvedSections,
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

  // Add-button wiring is per stream type (Scratchpads / Channels expose creators).
  const addWiringFor = (spec: SidebarSectionSpec): AddWiring | undefined => {
    if (spec.kind !== "type") return undefined
    if (spec.streamType === "scratchpad") {
      return {
        onAdd: () => void onCreateScratchpad(),
        addTooltip: scratchpadAddMenuActions ? "New scratchpad…" : "+ New Scratchpad",
        addMenuActions: scratchpadAddMenuActions,
      }
    }
    if (spec.streamType === "channel") {
      return { onAdd: () => void onCreateChannel(), addTooltip: "+ New Channel" }
    }
    return undefined
  }

  return (
    <>
      {resolvedSections.map(({ section, items }) => {
        const presentation = sectionPresentation(section.spec)
        if (presentation.hideWhenEmpty && items.length === 0) return null

        const state = getSectionState(section.id, presentation.defaultCollapse)
        const onToggle = () => toggleSectionState(section.id, presentation.defaultCollapse)
        const add = addWiringFor(section.spec)

        if (presentation.tiered) {
          return (
            <TieredStreamSection
              key={section.id}
              sectionKey={section.id}
              label={presentation.label}
              icon={presentation.icon}
              items={items}
              allStreams={processedStreams}
              workspaceId={workspaceId}
              activeStreamId={activeStreamId}
              getUnreadCount={getUnreadCount}
              getMentionCount={getMentionCount}
              state={state}
              onToggle={onToggle}
              moreState={getSectionState(moreKey(section.id), MORE_DEFAULT)}
              onToggleMore={() => toggleSectionState(moreKey(section.id), MORE_DEFAULT)}
              compact={presentation.compact}
              showPreviewOnHover={presentation.showPreviewOnHover}
              scrollContainerRef={scrollContainerRef}
              onAdd={add?.onAdd}
              addTooltip={add?.addTooltip}
              addMenuActions={add?.addMenuActions}
            />
          )
        }

        return (
          <StreamSection
            key={section.id}
            label={presentation.label}
            icon={presentation.icon}
            items={items}
            allStreams={processedStreams}
            workspaceId={workspaceId}
            activeStreamId={activeStreamId}
            getUnreadCount={getUnreadCount}
            getMentionCount={getMentionCount}
            state={state}
            onToggle={onToggle}
            compact={presentation.compact}
            showPreviewOnHover={presentation.showPreviewOnHover}
            scrollContainerRef={scrollContainerRef}
          />
        )
      })}
    </>
  )
}
