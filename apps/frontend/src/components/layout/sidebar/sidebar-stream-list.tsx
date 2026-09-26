import { Fragment, type ReactNode } from "react"
import { useLocation } from "react-router-dom"
import { CheckCheck, Inbox, ListX } from "lucide-react"
import { MAX_BOARD_SCOPE_STREAMS } from "@threahq/types"
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
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { LabelChip } from "@/components/labels/label-chip"
import { useInputMode } from "@/hooks/use-input-mode"
import { cn } from "@/lib/utils"
import type { CachedLabel } from "@/hooks"
import { StreamSection, TieredStreamSection, sectionVisibleItems } from "./sections"
import { StreamDropZone } from "./sidebar-dnd"
import { defaultSectionOrder, sectionOrderOptions } from "@threahq/types"
import { sectionPresentation, type SidebarSectionSpec } from "./sidebar-config"
import type { SectionViewChange, SectionViewOptions } from "./section-view-options"
import { findSourceLabelId, type ResolvedSection } from "./resolve-sections"
import { SidebarLabelsProvider } from "./sidebar-labels"
import { SidebarQuickJumpProvider, createQuickJumpCollector } from "./quick-jump"
import { SidebarStreamStepShortcuts } from "./stream-step"
import { browseStreamsAction, type SidebarActionItem } from "./sidebar-actions"
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

/** Inbox section header: the Inbox icon + label, matching the section header's
 *  uppercase styling. Top-level per INV-18. When `quiet` (no rows held or
 *  unread) both the icon and label drop to a muted tone so the caught-up
 *  header recedes instead of advertising itself. */
function UnreadSectionTitle({ label, quiet = false }: { label: string; quiet?: boolean }) {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide",
        quiet ? "text-muted-foreground/50" : "text-muted-foreground"
      )}
    >
      <Inbox className={cn("h-3.5 w-3.5 shrink-0", quiet ? "text-muted-foreground/40" : "text-primary")} aria-hidden />
      {label}
    </span>
  )
}

/** Inbox header actions: clear-read (held rows only) and clear-all. Unlike the
 *  row-level Settle button, these are always visible when shown — a static
 *  status control alongside "All caught up", not a hover reveal. */
function InboxHeaderActions({
  heldCount,
  totalCount,
  onClearRead,
  onClearAll,
}: {
  heldCount: number
  totalCount: number
  onClearRead: () => void
  onClearAll: () => void
}) {
  return (
    <div className="flex items-center gap-0.5">
      {heldCount > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onClearRead()
              }}
              aria-label={`Settle ${heldCount} read`}
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <CheckCheck className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            Settle {heldCount} read
          </TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onClearAll()
            }}
            aria-label={`Settle all ${totalCount}`}
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ListX className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          Settle all {totalCount}, marks them read
        </TooltipContent>
      </Tooltip>
    </div>
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
  /**
   * Change a section's view options (filter, order, reverse). The parent owns
   * the sidebar config, so the persisted write lives there; this component only
   * decides which sections offer which options (never in board mode).
   */
  onSectionViewChange: (sectionId: string, change: SectionViewChange) => void
  /** Resolve a stream's "· home" hint (custom section / pinned label) for Unread rows. */
  homeHintFor: (streamId: string) => string | null
  /** Board-mode descriptor when on `/board` (flag on); `null` in chats mode. Every
   *  row's board branch is gated on it, so chats mode is untouched. */
  boardMode?: SidebarBoardMode | null
  /** Clear one or more streams from the Inbox (row clear, header clear-read/clear-all). */
  onClearInbox: (streamIds: string[]) => void
  /** Track which Inbox row is pointer-hovered, for the clear-inbox shortcut. */
  onInboxRowHoverChange?: (streamId: string, hovering: boolean) => void
  /**
   * Formatted effective binding for the clear-inbox shortcut (e.g. "E"), shown
   * as the row Clear button's tooltip hint. `undefined` when the viewer
   * disabled or unbound it — the hint is omitted rather than shown stale.
   */
  clearInboxKeyHint?: string
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
  onSectionViewChange,
  homeHintFor,
  boardMode,
  onClearInbox,
  onInboxRowHoverChange,
  clearInboxKeyHint,
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
  // Filing a stream may strip the label section it is currently shown under, per
  // the user's preference — so both drops resolve that source label first.
  const handleDropIntoSection = (streamId: string, sectionId: string) => {
    const sourceLabelId = findSourceLabelId(streamId, resolvedSections)
    onFileStreamToSection(streamId, sectionId)
    if (sourceLabelId) onStreamMovedFromLabel(streamId, sourceLabelId)
  }

  const handleDropOntoLabel = (streamId: string, labelId: string) => {
    const sourceLabelId = findSourceLabelId(streamId, resolvedSections)
    onAssignStreamLabel(streamId, labelId)
    if (sourceLabelId && sourceLabelId !== labelId) onStreamMovedFromLabel(streamId, sourceLabelId)
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
        addMenuActions: scratchpadAddMenuActions && [
          ...scratchpadAddMenuActions,
          { ...browseStreamsAction(workspaceId, collapseOnMobile, "scratchpads"), separatorBefore: true },
        ],
      }
    }
    if (spec.streamType === "channel") {
      return { onAdd: () => void onCreateChannel(), addTooltip: "+ New Channel" }
    }
    return undefined
  }

  // Filled as the sections below render, so the quick-jump numbering can never
  // name a row the list didn't put on screen.
  const quickJump = createQuickJumpCollector()

  const sectionElements = resolvedSections.map(({ section, items }) => {
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
    const isInboxSection = isUnread
    const inboxStreamIds = isInboxSection ? items.map((item) => item.id) : []
    const inboxHeldStreamIds = isInboxSection
      ? items.filter((item) => getUnreadCount(item.id) === 0).map((item) => item.id)
      : []
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
    const dedupedScopeIds = canScopeAll ? Array.from(new Set(items.map(boardScopeStreamId).filter(Boolean))) : []
    const dedupedScopeIdCount = dedupedScopeIds.length
    const scopeIds = dedupedScopeIds.slice(0, MAX_BOARD_SCOPE_STREAMS)
    const scopeAllActive = canScopeAll && sameMembers(selection.scopeStreamIds, scopeIds)
    if (scopeAllActive) filterActive = true
    let scopeAllHref: string | undefined = undefined
    if (canScopeAll) {
      scopeAllHref = scopeAllActive ? boardMode.clearAxisHref(BOARD_SCOPE_PARAM) : boardMode.scopeAllHref(scopeIds)
    }
    // Active, the link CLEARS — name it for what it does. Otherwise the
    // scope caps at MAX_BOARD_SCOPE_STREAMS; say so rather than silently
    // scoping to a prefix of the section.
    let scopeAllTitle: string | undefined = undefined
    if (scopeAllActive) scopeAllTitle = `Clear board scope ${headerLabel}`
    else if (canScopeAll && dedupedScopeIdCount > MAX_BOARD_SCOPE_STREAMS)
      scopeAllTitle = `Scope board to the first ${MAX_BOARD_SCOPE_STREAMS} of ${dedupedScopeIdCount} streams`

    const state = getSectionState(section.id, presentation.defaultCollapse)
    const onToggle = () => toggleSectionState(section.id, presentation.defaultCollapse)
    const add = addWiringFor(section.spec)
    const moreState = getSectionState(moreKey(section.id), MORE_DEFAULT)
    // View options are chats-mode only: board-mode sections filter the board
    // instead via `filterAffordance`/`filterActive`. The Inbox has its own
    // read/unread model, so it offers order and reverse but no filter.
    const viewOptions: SectionViewOptions | undefined = boardMode
      ? undefined
      : {
          filter: section.spec.kind === "unread" ? undefined : (section.filter ?? "all"),
          order: section.order ?? defaultSectionOrder(section.spec),
          orderOptions: sectionOrderOptions(section.spec),
          reverse: section.reverse ?? false,
          onChange: (change) => onSectionViewChange(section.id, change),
        }
    // Walk exactly what this section is about to render: a tiered section or a
    // filtered one holds a tail behind the "more" expander, so raw items are
    // not its rows.
    if (state !== "collapsed") {
      const { visible: rows } = sectionVisibleItems(items, {
        tiered: presentation.tiered,
        filter: viewOptions?.filter ?? "all",
        moreOpen: moreState === "open",
        isActive: (streamId) => getUnreadCount(streamId) > 0 || getMentionCount(streamId) > 0,
      })
      for (const row of rows) quickJump.add(row.id)
    }
    // The Unread section's status rides in its header (right side), not a
    // footer row — so an empty section costs only the header, never a band
    // of dead space. An empty section shows a quiet "All caught up" and
    // drops its chevron (state/onToggle below): with no rows there's
    // nothing to collapse, so the header reads as pure status, not a
    // toggle. The header is always present, so showing/hiding the accessory
    // never reflows the list (INV-21).
    let unreadAccessory: ReactNode = undefined
    if (isEmptyUnread) {
      unreadAccessory = <span className="text-[11px] italic text-muted-foreground/50">All caught up</span>
    } else if (isInboxSection) {
      unreadAccessory = (
        <InboxHeaderActions
          heldCount={inboxHeldStreamIds.length}
          totalCount={inboxStreamIds.length}
          onClearRead={() => onClearInbox(inboxHeldStreamIds)}
          onClearAll={() => onClearInbox(inboxStreamIds)}
        />
      )
    }

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
        viewOptions={viewOptions}
        icon={presentation.icon}
        items={items}
        allStreams={processedStreams}
        workspaceId={workspaceId}
        activeStreamId={activeStreamId}
        getUnreadCount={getUnreadCount}
        getMentionCount={getMentionCount}
        state={state}
        onToggle={onToggle}
        moreState={moreState}
        onToggleMore={() => toggleSectionState(moreKey(section.id), MORE_DEFAULT)}
        compact={presentation.compact}
        showPreviewOnHover={presentation.showPreviewOnHover}
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
        viewOptions={viewOptions}
        icon={presentation.icon}
        items={items}
        allStreams={processedStreams}
        workspaceId={workspaceId}
        activeStreamId={activeStreamId}
        getUnreadCount={getUnreadCount}
        getMentionCount={getMentionCount}
        state={isEmptyUnread ? undefined : state}
        onToggle={isEmptyUnread ? undefined : onToggle}
        moreState={moreState}
        onToggleMore={() => toggleSectionState(moreKey(section.id), MORE_DEFAULT)}
        headerAccessory={unreadAccessory}
        compact={presentation.compact}
        showPreviewOnHover={presentation.showPreviewOnHover}
        streamDragEnabled={streamDragEnabled}
        homeHintFor={isUnread ? homeHintFor : undefined}
        boardMode={boardMode}
        isInboxSection={isInboxSection}
        onClearInboxRow={isInboxSection ? (streamId: string) => onClearInbox([streamId]) : undefined}
        onInboxRowHoverChange={isInboxSection ? onInboxRowHoverChange : undefined}
        clearInboxKeyHint={isInboxSection ? clearInboxKeyHint : undefined}
      />
    )

    // Custom and label sections are drop targets — a stream dragged onto a
    // custom section is filed there; one dragged onto a label section is
    // tagged with that label. Other section kinds render as-is.
    if (section.spec.kind === "custom") {
      const sectionId = section.spec.sectionId
      return (
        <StreamDropZone
          key={section.id}
          enabled={streamDragEnabled}
          workspaceId={workspaceId}
          onDropStream={(streamId) => handleDropIntoSection(streamId, sectionId)}
        >
          {sectionEl}
        </StreamDropZone>
      )
    }
    if (section.spec.kind === "label") {
      const labelId = section.spec.labelId
      return (
        <StreamDropZone
          key={section.id}
          enabled={streamDragEnabled}
          workspaceId={workspaceId}
          onDropStream={(streamId) => handleDropOntoLabel(streamId, labelId)}
        >
          {sectionEl}
        </StreamDropZone>
      )
    }
    return <Fragment key={section.id}>{sectionEl}</Fragment>
  })

  return (
    <SidebarLabelsProvider workspaceId={workspaceId}>
      <SidebarQuickJumpProvider workspaceId={workspaceId} order={quickJump.ids}>
        <SidebarStreamStepShortcuts workspaceId={workspaceId} order={quickJump.order} activeStreamId={activeStreamId} />
        {/* A provided slot renders at its section's position below; when the user's
            layout has NO quicklinks section it renders first instead of vanishing.
            Chats mode never hits this (its slot is built only when the section
            exists) — it exists for board mode, whose slot carries the board's
            filters/views/lenses and must survive the section's removal. */}
        {quickLinksSlot && !resolvedSections.some(({ section }) => section.spec.kind === "quicklinks")
          ? quickLinksSlot
          : null}
        {sectionElements}
      </SidebarQuickJumpProvider>
    </SidebarLabelsProvider>
  )
}
