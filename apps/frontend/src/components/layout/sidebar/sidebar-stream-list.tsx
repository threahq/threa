import { Fragment, useState, type ReactNode, type RefObject } from "react"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import { useLocation } from "react-router-dom"
import { MAX_BOARD_SCOPE_STREAMS } from "@threa/types"
import { useSidebar, type CollapseState } from "@/contexts"
import { useBoardSelection } from "@/hooks/use-board-selection"
import {
  BOARD_LABEL_PARAM,
  BOARD_SCOPE_PARAM,
  BOARD_TYPE_PARAM,
  BOARD_UNREAD_PARAM,
  BOARD_UNREAD_ON,
} from "@/components/board/board-filter-params"
import { Button } from "@/components/ui/button"
import { LabelChip } from "@/components/labels/label-chip"
import { useInputMode } from "@/hooks/use-input-mode"
import { cn } from "@/lib/utils"
import { streamLabel } from "@/lib/streams"
import type { CachedLabel } from "@/hooks"
import { StreamSection, TieredStreamSection } from "./sections"
import {
  CustomSectionDropZone,
  LabelSectionDropZone,
  customSectionIdFromDropData,
  labelIdFromDropData,
  streamIdFromDragData,
} from "./sidebar-dnd"
import { sectionPresentation, type SidebarSectionSpec } from "./sidebar-config"
import { findSourceLabelId, type ResolvedSection } from "./resolve-sections"
import { SidebarLabelsProvider } from "./sidebar-labels"
import type { SidebarActionItem } from "./sidebar-actions"
import { boardScopeStreamId, type SidebarBoardMode } from "./board-sidebar-mode"
import type { StreamItemData } from "./types"

/** Default state of the "more" expander: collapsed so quiet tails stay hidden. */
const MORE_DEFAULT: CollapseState = "collapsed"

/** Key for the inline "more" expander of a parent section. */
function moreKey(parent: string): string {
  return `${parent}:more`
}

/** The board's axis is filtered to exactly this one value — what makes a section
 *  header's filter read as active (and its click un-toggle). */
function isSoleValue<T>(selected: readonly T[], value: T): boolean {
  return selected.length === 1 && selected[0] === value
}

/** The board's `?in=` scope is exactly this section's streams, order-insensitive. */
function sameMembers(selected: readonly string[], ids: readonly string[]): boolean {
  const wanted = new Set(ids)
  if (selected.length !== wanted.size || wanted.size === 0) return false
  return selected.every((id) => wanted.has(id))
}

interface AddWiring {
  onAdd: () => void
  addTooltip: string
  addMenuActions?: SidebarActionItem[]
}

/** Unread section header: a gold thread dot + the label, matching the section
 *  header's uppercase styling. Gold (not a colored emoji) keeps the palette
 *  (DESIGN.md §0). Top-level per INV-18. When `quiet` (no unread streams) both
 *  the dot and label drop to a muted tone so the caught-up header recedes
 *  instead of advertising itself — the gold dot is reserved for "there's unread
 *  here". */
function UnreadSectionTitle({ label, quiet = false }: { label: string; quiet?: boolean }) {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide",
        quiet ? "text-muted-foreground/50" : "text-muted-foreground"
      )}
    >
      <span
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", quiet ? "bg-muted-foreground/40" : "bg-primary")}
        aria-hidden
      />
      {label}
    </span>
  )
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
  /**
   * File a stream into the custom section with this id (drag-and-drop drop). The
   * parent owns the sidebar config, so the membership write lives there.
   */
  onFileStreamToSection: (streamId: string, customSectionId: string) => void
  /**
   * Apply a label to a stream dragged onto its label section (drag-and-drop
   * drop). The parent owns the label mutation and the unfile-from-custom write.
   */
  onAssignStreamLabel: (streamId: string, labelId: string) => void
  /**
   * A stream was dragged out of the label section it was sitting under (into a
   * custom section or a different label). The parent decides — per the user's
   * `labelRemoveOnMove` preference — whether to strip the old label, prompting
   * when set to "ask".
   */
  onStreamMovedFromLabel: (streamId: string, sourceLabelId: string) => void
  /** Resolve a stream's "· home" hint (custom section / pinned label) for Unread rows. */
  homeHintFor: (streamId: string) => string | null
  scrollContainerRef: RefObject<HTMLDivElement | null>
  /** Board-mode descriptor when on `/board` (flag on); `null` in chats mode. Every
   *  row's board branch is gated on it, so chats mode is untouched. */
  boardMode?: SidebarBoardMode | null
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
  onFileStreamToSection,
  onAssignStreamLabel,
  onStreamMovedFromLabel,
  homeHintFor,
  scrollContainerRef,
  boardMode,
}: SidebarStreamListProps) {
  // Drag-to-file is a mouse interaction; a finger does the same through the
  // action drawer's section picker. Keyed on the active input (not capability)
  // so a mouse can drag even on a touchscreen device, while a finger can't drag
  // and keeps scroll/long-press intact.
  const streamDragEnabled = useInputMode() !== "touch"
  // Opening a label from its section header should close the sidebar on mobile,
  // matching stream rows and quick links (no-op on desktop).
  const { collapseOnMobile } = useSidebar()
  // The live board selection, so a section header can tell whether the board is
  // already filtered to its own axis (INV-35: the same derivation the board block
  // and the filter chips read).
  const { selection } = useBoardSelection()
  const unreadFilterOn = new URLSearchParams(useLocation().search).get(BOARD_UNREAD_PARAM) === BOARD_UNREAD_ON
  const [draggingStreamId, setDraggingStreamId] = useState<string | null>(null)
  // Distance constraint so a click still navigates the row's link — a drag only
  // begins once the pointer has moved past the threshold.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const handleDragStart = (event: DragStartEvent) => {
    setDraggingStreamId(streamIdFromDragData(event.active.data.current))
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setDraggingStreamId(null)
    const streamId = streamIdFromDragData(event.active.data.current)
    if (!streamId) return
    // The label section the stream is currently shown under (if any) — dropping
    // it elsewhere may strip this label, per the user's preference.
    const sourceLabelId = findSourceLabelId(streamId, resolvedSections)
    // A drop lands on exactly one zone; file into a custom section or, when the
    // target is a label section, apply that label instead.
    const customSectionId = customSectionIdFromDropData(event.over?.data.current)
    if (customSectionId) {
      onFileStreamToSection(streamId, customSectionId)
      if (sourceLabelId) onStreamMovedFromLabel(streamId, sourceLabelId)
      return
    }
    const labelId = labelIdFromDropData(event.over?.data.current)
    if (labelId) {
      onAssignStreamLabel(streamId, labelId)
      if (sourceLabelId && sourceLabelId !== labelId) onStreamMovedFromLabel(streamId, sourceLabelId)
    }
  }

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

  const draggingStream = draggingStreamId ? processedStreams.find((s) => s.id === draggingStreamId) : null

  return (
    <SidebarLabelsProvider workspaceId={workspaceId}>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setDraggingStreamId(null)}
      >
        {/* A provided slot renders at its section's position below; when the user's
            layout has NO quicklinks section it renders first instead of vanishing.
            Chats mode never hits this (its slot is built only when the section
            exists) — it exists for board mode, whose slot carries the board's
            filters/views/lenses and must survive the section's removal. */}
        {quickLinksSlot && !resolvedSections.some(({ section }) => section.spec.kind === "quicklinks")
          ? quickLinksSlot
          : null}
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
          const isUnread = section.spec.kind === "unread"
          const isEmptyUnread = isUnread && items.length === 0
          // Unread's header is a gold dot + label (a colored emoji would break the
          // gold-on-paper palette); label sections use their tinted chip. An empty
          // Unread section mutes the dot + label so the caught-up header recedes.
          let titleContent: ReactNode = undefined
          if (label) titleContent = <LabelChip label={label} />
          else if (isUnread) titleContent = <UnreadSectionTitle label={presentation.label} quiet={isEmptyUnread} />
          // Label sections get an "open" affordance: the label landing page in
          // chats mode, or — in board mode — the board's own label axis
          // (`?label=<id>`), which stays live as assignments change (design doc
          // § "Feature parity").
          let titleHref = label ? `/w/${workspaceId}/labels/${label.id}` : undefined
          let titleActionLabel: string | undefined = undefined
          // Board mode: the affordance is a FILTER, so it also un-toggles —
          // when the board is already filtered to exactly this section's axis the
          // link points at the clearing URL and the icon reads active.
          let filterActive = false
          if (label && boardMode) {
            filterActive = isSoleValue(selection.scopeLabelIds, label.id)
            titleHref = filterActive ? boardMode.clearAxisHref(BOARD_LABEL_PARAM) : boardMode.labelFocusHref(label.id)
            titleActionLabel = filterActive ? `Clear board filter ${label.name}` : `Filter board by ${label.name}`
          }
          // Board mode only, mirroring the label case above: a type section
          // (Channels/DMs/Scratchpads) focuses the board's type axis (`?is=`),
          // and Unread focuses the unread axis (`?unread=true`) — both live
          // aggregate filters, not a one-time snapshot of the current ids.
          if (boardMode && section.spec.kind === "type") {
            filterActive = isSoleValue(selection.scopeStreamTypes, section.spec.streamType)
            titleHref = filterActive
              ? boardMode.clearAxisHref(BOARD_TYPE_PARAM)
              : boardMode.typeFocusHref(section.spec.streamType)
            titleActionLabel = filterActive
              ? `Clear board filter ${presentation.label}`
              : `Filter board by ${presentation.label}`
          } else if (boardMode && section.spec.kind === "unread") {
            filterActive = unreadFilterOn
            titleHref = filterActive ? boardMode.clearAxisHref(BOARD_UNREAD_PARAM) : boardMode.unreadFocusHref()
            titleActionLabel = filterActive ? "Clear board unread filter" : "Filter board by unread"
          }
          const headerLabel = label ? label.name : presentation.label

          // Board mode only: smart and custom-section headers gain a "Scope all"
          // link that scopes `?in=` to every stream in the section at once. Rows
          // resolve to their board scope id (threads → root), deduped/capped by
          // the helper. Type/label/unread sections use a live aggregate filter
          // (above) instead — their membership already has a query-language
          // equivalent, so scoping to a frozen id snapshot would be a downgrade.
          const canScopeAll =
            !!boardMode && (section.spec.kind === "smart" || section.spec.kind === "custom") && items.length > 0
          // Normalize exactly as scopeAllSearch does (dedupe, keep-first cap) so
          // the active check compares against the ids the URL can actually hold —
          // an uncapped comparison never matches for an oversized section.
          const scopeIds = canScopeAll
            ? Array.from(new Set(items.map(boardScopeStreamId).filter(Boolean))).slice(0, MAX_BOARD_SCOPE_STREAMS)
            : []
          const scopeAllActive = canScopeAll && sameMembers(selection.scopeStreamIds, scopeIds)
          if (scopeAllActive) filterActive = true
          let scopeAllHref: string | undefined = undefined
          if (canScopeAll) {
            scopeAllHref = scopeAllActive
              ? boardMode.clearAxisHref(BOARD_SCOPE_PARAM)
              : boardMode.scopeAllHref(scopeIds)
          }
          // Active, the link CLEARS — name it for what it does. Otherwise the
          // scope caps at MAX_BOARD_SCOPE_STREAMS; say so rather than silently
          // scoping to a prefix of the section.
          let scopeAllTitle: string | undefined = undefined
          if (scopeAllActive) scopeAllTitle = `Clear board scope ${headerLabel}`
          else if (canScopeAll && items.length > MAX_BOARD_SCOPE_STREAMS)
            scopeAllTitle = `Scope board to the first ${MAX_BOARD_SCOPE_STREAMS} of ${items.length} streams`

          const state = getSectionState(section.id, presentation.defaultCollapse)
          const onToggle = () => toggleSectionState(section.id, presentation.defaultCollapse)
          const add = addWiringFor(section.spec)
          // The Unread section's status rides in its header (right side), not a
          // footer row — so an empty section costs only the header, never a band
          // of dead space. An empty section shows a quiet "All caught up" and
          // drops its chevron (state/onToggle below): with no rows there's
          // nothing to collapse, so the header reads as pure status, not a
          // toggle. The header is always present, so showing/hiding the accessory
          // never reflows the list (INV-21).
          const unreadAccessory: ReactNode = isEmptyUnread ? (
            <span className="text-[11px] italic text-muted-foreground/50">All caught up</span>
          ) : undefined

          const sectionEl = presentation.tiered ? (
            <TieredStreamSection
              sectionKey={section.id}
              label={headerLabel}
              titleContent={titleContent}
              titleHref={titleHref}
              titleActionLabel={titleActionLabel}
              onTitleNavigate={collapseOnMobile}
              scopeAllHref={scopeAllHref}
              scopeAllTitle={scopeAllTitle}
              filterAffordance={!!boardMode}
              filterActive={filterActive}
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
              streamDragEnabled={streamDragEnabled}
              boardMode={boardMode}
            />
          ) : (
            <StreamSection
              label={headerLabel}
              titleContent={titleContent}
              titleHref={titleHref}
              titleActionLabel={titleActionLabel}
              onTitleNavigate={collapseOnMobile}
              scopeAllHref={scopeAllHref}
              scopeAllTitle={scopeAllTitle}
              filterAffordance={!!boardMode}
              filterActive={filterActive}
              icon={presentation.icon}
              items={items}
              allStreams={processedStreams}
              workspaceId={workspaceId}
              activeStreamId={activeStreamId}
              getUnreadCount={getUnreadCount}
              getMentionCount={getMentionCount}
              state={isEmptyUnread ? undefined : state}
              onToggle={isEmptyUnread ? undefined : onToggle}
              headerAccessory={unreadAccessory}
              compact={presentation.compact}
              showPreviewOnHover={presentation.showPreviewOnHover}
              scrollContainerRef={scrollContainerRef}
              streamDragEnabled={streamDragEnabled}
              homeHintFor={isUnread ? homeHintFor : undefined}
              boardMode={boardMode}
            />
          )

          // Custom and label sections are drop targets — a stream dragged onto a
          // custom section is filed there; one dragged onto a label section is
          // tagged with that label. Other section kinds render as-is.
          if (section.spec.kind === "custom") {
            return (
              <CustomSectionDropZone key={section.id} sectionId={section.spec.sectionId} enabled={streamDragEnabled}>
                {sectionEl}
              </CustomSectionDropZone>
            )
          }
          if (section.spec.kind === "label") {
            return (
              <LabelSectionDropZone key={section.id} labelId={section.spec.labelId} enabled={streamDragEnabled}>
                {sectionEl}
              </LabelSectionDropZone>
            )
          }
          return <Fragment key={section.id}>{sectionEl}</Fragment>
        })}

        {/* A small chip trails the cursor while filing a stream, so the drag reads
          as intentional even though the source row stays put (dimmed). */}
        <DragOverlay dropAnimation={null}>
          {draggingStream ? (
            <div className="pointer-events-none rounded-md border bg-card px-2.5 py-1.5 text-sm font-medium shadow-md">
              {streamLabel(draggingStream, "sidebar")}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </SidebarLabelsProvider>
  )
}
