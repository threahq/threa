import { Fragment, type ReactNode, type RefObject } from "react"
import type { CollapseState } from "@/contexts"
import { Button } from "@/components/ui/button"
import { LabelChip } from "@/components/labels/label-chip"
import type { CachedLabel } from "@/hooks"
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
  /** Labels visible to the viewer, by id — resolves the header chip for `label` sections. */
  labelsById: Map<string, CachedLabel>
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
  /**
   * The Quick Links block, rendered at the position of the `quicklinks` section
   * in the config. Passed in (rather than built here) because it needs the live
   * counts/route signals the sidebar owns; `null` when the user removed the block.
   */
  quickLinksSlot?: ReactNode
  scrollContainerRef: RefObject<HTMLDivElement | null>
}

export function SidebarStreamList({
  workspaceId,
  hasError,
  hasUserStreams,
  activeStreamId,
  processedStreams,
  resolvedSections,
  labelsById,
  getUnreadCount,
  getMentionCount,
  getSectionState,
  toggleSectionState,
  onCreateScratchpad,
  onCreateChannel,
  scratchpadAddMenuActions,
  quickLinksSlot,
  scrollContainerRef,
}: SidebarStreamListProps) {
  if (hasError) {
    return <p className="px-2 py-4 text-xs text-destructive text-center">Failed to load</p>
  }

  if (!hasUserStreams) {
    return (
      <>
        {quickLinksSlot}
        <div className="px-4 py-8 text-center">
          <p className="text-sm text-muted-foreground mb-4">No streams yet</p>
          <Button variant="outline" size="sm" onClick={() => void onCreateScratchpad()} className="mr-2">
            + New Scratchpad
          </Button>
          <Button variant="outline" size="sm" onClick={() => void onCreateChannel()}>
            + New Channel
          </Button>
        </div>
      </>
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
        // The Quick Links block renders its own link list at this position. The
        // slot owns its spacing (and may render null when every link is hidden),
        // so it's not wrapped — a wrapper would leave a stray margin when empty.
        if (section.spec.kind === "quicklinks") {
          return quickLinksSlot ? <Fragment key={section.id}>{quickLinksSlot}</Fragment> : null
        }

        const presentation = sectionPresentation(section.spec)
        if (presentation.hideWhenEmpty && items.length === 0) return null

        // Label sections render a tinted chip header resolved from the labels
        // cache; a section whose label was archived/deleted is an orphan — skip it.
        const label = section.spec.kind === "label" ? labelsById.get(section.spec.labelId) : undefined
        if (section.spec.kind === "label" && !label) return null
        const titleContent = label ? <LabelChip label={label} /> : undefined
        const headerLabel = label ? label.name : presentation.label

        const state = getSectionState(section.id, presentation.defaultCollapse)
        const onToggle = () => toggleSectionState(section.id, presentation.defaultCollapse)
        const add = addWiringFor(section.spec)

        if (presentation.tiered) {
          return (
            <TieredStreamSection
              key={section.id}
              sectionKey={section.id}
              label={headerLabel}
              titleContent={titleContent}
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
            label={headerLabel}
            titleContent={titleContent}
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
