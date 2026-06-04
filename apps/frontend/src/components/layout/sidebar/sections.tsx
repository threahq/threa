import { ArrowUpRight, ChevronDown, ChevronRight, ChevronUp, Plus } from "lucide-react"
import { Fragment, type ReactNode, type RefObject } from "react"
import { Link } from "react-router-dom"
import type { CollapseState } from "@/contexts"
import { cn } from "@/lib/utils"
import { UnreadBadge } from "@/components/unread-badge"
import { isDraftId } from "@/hooks"
import { SidebarActionMenu, type SidebarActionItem } from "./sidebar-actions"
import { StreamItem } from "./stream-item"
import { DraggableStreamRow } from "./sidebar-dnd"
import type { StreamItemData } from "./types"
import { getActivityTime } from "./utils"

interface SectionHeaderProps {
  label: string
  icon?: string
  /**
   * Renders in place of the plain `{icon} {label}` title (chevron and right-side
   * controls are kept). Used by label sections to show a tinted `LabelChip`.
   */
  titleContent?: ReactNode
  /**
   * When set, the header shows a hover-revealed "open" link to this route (e.g. a
   * label section linking to its landing page). The header click still toggles
   * collapse; this is a separate affordance on the right, like the "+" button.
   */
  titleHref?: string
  /** Current collapse state. If omitted, header renders as static (non-clickable). */
  state?: CollapseState
  /** Toggle callback. If omitted, header renders as static. */
  onToggle?: () => void
  /** Aggregate unread count across items in the section (shown on collapsed header). */
  unreadAggregate?: number
  /** Aggregate mention count across items in the section (colors the badge on collapsed header). */
  mentionAggregate?: number
  /** Add button callback - shows plus icon on hover. Ignored if `addMenuActions` is set. */
  onAdd?: () => void
  /** Tooltip for add button */
  addTooltip?: string
  /**
   * When provided, the "+" button opens a dropdown menu of these actions instead
   * of invoking `onAdd` directly. Used by Scratchpads to expose Quick Note /
   * Encrypted Scratchpad alongside the default Scratchpad creator.
   */
  addMenuActions?: SidebarActionItem[] | null
  /** Smaller header style used for nested subsections (e.g. "With activity" / "Rest"). */
  nested?: boolean
}

/** Section header with chevron state indicator. Consistent across all sidebar sections. */
export function SectionHeader({
  label,
  icon,
  titleContent,
  titleHref,
  state,
  onToggle,
  unreadAggregate = 0,
  mentionAggregate = 0,
  onAdd,
  addTooltip,
  addMenuActions,
  nested = false,
}: SectionHeaderProps) {
  const isInteractive = !!onToggle && !!state
  const isCollapsed = state === "collapsed"
  let headerTitle: string | undefined
  if (state) {
    const verb = isCollapsed ? "Expand" : "Collapse"
    // Name the section so multiple collapsed headers (e.g. several label
    // sections) stay distinguishable to screen readers and on hover.
    headerTitle = label ? `${verb} ${label}` : `${verb} section`
  }
  const hasAggregate = isCollapsed && unreadAggregate > 0
  const hasMentions = mentionAggregate > 0
  const hasMenu = !!addMenuActions && addMenuActions.length > 0

  const Chevron = isCollapsed ? ChevronRight : ChevronDown

  const addButton = (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        if (!hasMenu) onAdd?.()
      }}
      // Mobile is the implicit base case (no opacity rule → always visible);
      // desktop hides until the section is hovered. Inverting the cascade
      // this way avoids the previous `opacity-0 max-sm:opacity-100` ordering
      // which left mobile users without a "+" on collapsed sections.
      className="h-5 w-5 max-sm:h-8 max-sm:w-8 flex items-center justify-center rounded sm:opacity-0 sm:group-hover/section:opacity-100 hover:bg-muted transition-all"
      title={addTooltip}
      aria-label={addTooltip}
    >
      <Plus className="h-3.5 w-3.5" />
    </button>
  )

  const headingContent = (
    <div className="flex items-center gap-1.5 min-w-0">
      {isInteractive && <Chevron className="h-3 w-3 text-muted-foreground/70 shrink-0" aria-hidden />}
      {titleContent ? (
        // Keep the heading element (and its name) so screen-readers navigating by
        // heading still reach label sections; the chip supplies its own styling.
        <h3 className="m-0 min-w-0 truncate">{titleContent}</h3>
      ) : (
        <h3
          className={cn(
            "font-semibold uppercase tracking-wide text-muted-foreground m-0 truncate",
            nested ? "text-[10px]" : "text-xs",
            hasAggregate && "text-foreground"
          )}
        >
          {icon && `${icon} `}
          {label}
        </h3>
      )}
    </div>
  )

  // Stop event propagation on the rightContent: the DropdownMenuContent
  // renders in a React portal, but React still propagates synthetic events
  // through the React tree — without this guard, clicking (or pressing
  // Enter/Space on) a menu item bubbles up to the header's `onToggle` and
  // collapses the section as a side effect.
  const rightContent = (
    <div
      className="flex items-center gap-1"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {titleHref && (
        <Link
          to={titleHref}
          // Mirrors the "+" button's reveal: hover-only on desktop, always shown
          // on mobile (no hover). The wrapper above stops propagation, so opening
          // the label never also toggles the section.
          className="h-5 w-5 max-sm:h-8 max-sm:w-8 flex items-center justify-center rounded sm:opacity-0 sm:group-hover/section:opacity-100 hover:bg-muted transition-all"
          title={label ? `Open ${label}` : "Open"}
          aria-label={label ? `Open ${label}` : "Open"}
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      )}
      {hasAggregate && (
        <UnreadBadge
          count={unreadAggregate}
          className={cn(
            "h-4 min-w-4 text-[10px] px-1",
            hasMentions ? "bg-destructive text-destructive-foreground" : undefined
          )}
        />
      )}
      {addMenuActions && addMenuActions.length > 0 ? (
        <SidebarActionMenu
          actions={addMenuActions}
          trigger={addButton}
          ariaLabel={addTooltip ?? "Create"}
          align="end"
          contentClassName="w-56"
        />
      ) : (
        onAdd && addButton
      )}
    </div>
  )

  const paddingClass = nested ? "px-2 py-1" : "px-3 py-2"

  if (isInteractive) {
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label={headerTitle}
        aria-expanded={!isCollapsed}
        title={headerTitle}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onToggle()
          }
        }}
        className={cn(
          "group/section w-full flex items-center justify-between rounded-md cursor-pointer select-none [-webkit-touch-callout:none]",
          paddingClass,
          "hover:bg-muted/50 transition-colors"
        )}
      >
        {headingContent}
        {rightContent}
      </div>
    )
  }

  return (
    <div
      className={cn(
        "group/section flex items-center justify-between select-none [-webkit-touch-callout:none]",
        paddingClass
      )}
    >
      {headingContent}
      {rightContent}
    </div>
  )
}

/** Sum unread counts across a list of streams. */
function sumUnread(items: StreamItemData[], getUnreadCount: (streamId: string) => number): number {
  let total = 0
  for (const stream of items) total += getUnreadCount(stream.id)
  return total
}

/** Sum mention counts across a list of streams. */
function sumMentions(items: StreamItemData[], getMentionCount: (streamId: string) => number): number {
  let total = 0
  for (const stream of items) total += getMentionCount(stream.id)
  return total
}

/** Items with any unread or mention signal, sorted by recency (most recent first). */
function filterActiveByRecency(
  items: StreamItemData[],
  getUnreadCount: (streamId: string) => number,
  getMentionCount: (streamId: string) => number
): StreamItemData[] {
  return items
    .filter((stream) => getUnreadCount(stream.id) > 0 || getMentionCount(stream.id) > 0)
    .sort((a, b) => getActivityTime(b) - getActivityTime(a))
}

interface StreamSectionProps {
  label: string
  icon?: string
  /** Custom header title node (e.g. a label chip), forwarded to SectionHeader. */
  titleContent?: ReactNode
  /** Optional "open" link for the header (e.g. a label section → its landing page). */
  titleHref?: string
  items: StreamItemData[]
  allStreams: StreamItemData[]
  workspaceId: string
  activeStreamId?: string
  getUnreadCount: (streamId: string) => number
  getMentionCount: (streamId: string) => number
  state?: CollapseState
  onToggle?: () => void
  action?: ReactNode
  /** Show compact view (title only, no preview) */
  compact?: boolean
  /** Show preview on hover when compact (only works with compact=true) */
  showPreviewOnHover?: boolean
  /** Reference to scroll container for position tracking */
  scrollContainerRef?: RefObject<HTMLDivElement | null>
  /** Add button callback - shows plus icon in header */
  onAdd?: () => void
  /** Tooltip for add button */
  addTooltip?: string
  /** Dropdown actions for the "+" button. Overrides `onAdd` when provided. */
  addMenuActions?: SidebarActionItem[] | null
  /** When true, each stream row is a drag source for filing into a custom section (desktop). */
  streamDragEnabled?: boolean
}

/** Simple binary collapsible section used for Important / Recent / Pinned. */
export function StreamSection({
  label,
  icon,
  titleContent,
  titleHref,
  items,
  allStreams,
  workspaceId,
  activeStreamId,
  getUnreadCount,
  getMentionCount,
  state = "open",
  onToggle,
  action,
  compact = false,
  showPreviewOnHover = false,
  scrollContainerRef,
  onAdd,
  addTooltip,
  addMenuActions,
  streamDragEnabled = false,
}: StreamSectionProps) {
  const isCollapsed = state === "collapsed"
  const unreadAggregate = sumUnread(items, getUnreadCount)
  const mentionAggregate = sumMentions(items, getMentionCount)

  const renderRow = (stream: StreamItemData) => {
    const item = (
      <StreamItem
        workspaceId={workspaceId}
        stream={stream}
        isActive={stream.id === activeStreamId}
        unreadCount={getUnreadCount(stream.id)}
        mentionCount={getMentionCount(stream.id)}
        allStreams={allStreams}
        compact={compact}
        showPreviewOnHover={showPreviewOnHover}
        scrollContainerRef={scrollContainerRef}
      />
    )
    // Wrap as a drag source only when dragging is on (desktop) and the row is a
    // persisted stream — drafts (incl. virtual DMs) carry transient ids that
    // must never be filed into config, and wrapping a disabled row would
    // register a dead draggable for nothing.
    const dragEnabled = streamDragEnabled && !isDraftId(stream.id)
    return dragEnabled ? (
      <DraggableStreamRow key={stream.id} streamId={stream.id}>
        {item}
      </DraggableStreamRow>
    ) : (
      <Fragment key={stream.id}>{item}</Fragment>
    )
  }

  return (
    <div className="mb-4">
      <SectionHeader
        label={label}
        icon={icon}
        titleContent={titleContent}
        titleHref={titleHref}
        state={state}
        onToggle={onToggle}
        unreadAggregate={unreadAggregate}
        mentionAggregate={mentionAggregate}
        onAdd={onAdd}
        addTooltip={addTooltip}
        addMenuActions={addMenuActions}
      />

      {!isCollapsed && items.length > 0 && <div className="mt-1 flex flex-col gap-0.5">{items.map(renderRow)}</div>}

      {!isCollapsed && action}
    </div>
  )
}

interface TieredStreamSectionProps extends Omit<StreamSectionProps, "action" | "state" | "onToggle"> {
  /** Parent section key (drives the "more" persistence key). */
  sectionKey: string
  /** Current parent open/collapsed state. */
  state: CollapseState
  /** Toggle the parent section. */
  onToggle: () => void
  /**
   * Current state of the inline "more" expander. `"open"` shows the full tail,
   * `"collapsed"` keeps it hidden behind the more button.
   */
  moreState: CollapseState
  /** Toggle the inline "more" expander. */
  onToggleMore: () => void
  action?: ReactNode
}

/** Soft cap on visible items when the more expander is collapsed. */
const TIER_VISIBLE_LIMIT = 10

/**
 * Single-list section with a tiered reveal:
 *
 * - All streams with activity (unread / mentions) always render at the top,
 *   sorted by recency.
 * - The list is then filled with quieter streams up to {@link TIER_VISIBLE_LIMIT}
 *   total items.
 * - Any remaining streams hide behind an inline "more" divider that expands
 *   to the full list. The divider aligns with the stream items (same padding)
 *   and is persisted per-section.
 */
export function TieredStreamSection({
  label,
  icon,
  titleContent,
  titleHref,
  items,
  allStreams,
  workspaceId,
  activeStreamId,
  getUnreadCount,
  getMentionCount,
  state,
  onToggle,
  moreState,
  onToggleMore,
  action,
  compact = false,
  showPreviewOnHover = false,
  scrollContainerRef,
  onAdd,
  addTooltip,
  addMenuActions,
  streamDragEnabled = false,
}: TieredStreamSectionProps) {
  const isCollapsed = state === "collapsed"
  const unreadAggregate = sumUnread(items, getUnreadCount)
  const mentionAggregate = sumMentions(items, getMentionCount)

  const activeItems = filterActiveByRecency(items, getUnreadCount, getMentionCount)
  const activeIds = new Set(activeItems.map((s) => s.id))
  const quietItems = items.filter((s) => !activeIds.has(s.id))

  // Fill the visible tier with quiet items up to the soft cap. Actives always
  // render in full, even if that pushes past the cap.
  const quietFillCount = Math.max(0, TIER_VISIBLE_LIMIT - activeItems.length)
  const quietVisible = quietItems.slice(0, quietFillCount)
  const quietHidden = quietItems.slice(quietFillCount)
  const hasMore = quietHidden.length > 0
  const isMoreOpen = moreState === "open"
  const visibleItems = isMoreOpen ? [...activeItems, ...quietItems] : [...activeItems, ...quietVisible]

  const renderItem = (stream: StreamItemData) => {
    const item = (
      <StreamItem
        workspaceId={workspaceId}
        stream={stream}
        isActive={stream.id === activeStreamId}
        unreadCount={getUnreadCount(stream.id)}
        mentionCount={getMentionCount(stream.id)}
        allStreams={allStreams}
        compact={compact}
        showPreviewOnHover={showPreviewOnHover}
        scrollContainerRef={scrollContainerRef}
      />
    )
    // Drag source only for persisted streams when dragging is on; see StreamSection.renderRow.
    const dragEnabled = streamDragEnabled && !isDraftId(stream.id)
    return dragEnabled ? (
      <DraggableStreamRow key={stream.id} streamId={stream.id}>
        {item}
      </DraggableStreamRow>
    ) : (
      <Fragment key={stream.id}>{item}</Fragment>
    )
  }

  return (
    <div className="mb-4">
      <SectionHeader
        label={label}
        icon={icon}
        titleContent={titleContent}
        titleHref={titleHref}
        state={state}
        onToggle={onToggle}
        unreadAggregate={unreadAggregate}
        mentionAggregate={mentionAggregate}
        onAdd={onAdd}
        addTooltip={addTooltip}
        addMenuActions={addMenuActions}
      />

      {!isCollapsed && visibleItems.length > 0 && (
        <div className="mt-1 flex flex-col gap-0.5">{visibleItems.map(renderItem)}</div>
      )}

      {!isCollapsed && hasMore && (
        <MoreDivider isOpen={isMoreOpen} hiddenCount={quietHidden.length} onToggle={onToggleMore} />
      )}

      {!isCollapsed && action}
    </div>
  )
}

interface MoreDividerProps {
  isOpen: boolean
  hiddenCount: number
  onToggle: () => void
}

/**
 * Slim divider with a centered "more" (or "less") label and a chevron. Sits
 * flush with stream items via matching horizontal padding so it feels like a
 * peer of the list, not a separate control.
 */
function MoreDivider({ isOpen, hiddenCount, onToggle }: MoreDividerProps) {
  const Chevron = isOpen ? ChevronUp : ChevronDown
  const label = isOpen ? "less" : `${hiddenCount} more`
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isOpen}
      className="mt-0.5 flex w-full items-center gap-2 px-3 py-1 text-[11px] uppercase tracking-wide text-muted-foreground/70 hover:text-foreground transition-colors"
    >
      <span className="h-px flex-1 bg-border/70" aria-hidden />
      <span className="flex items-center gap-1">
        {label}
        <Chevron className="h-3 w-3" aria-hidden />
      </span>
      <span className="h-px flex-1 bg-border/70" aria-hidden />
    </button>
  )
}
