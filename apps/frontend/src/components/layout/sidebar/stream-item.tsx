import { useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react"
import {
  Ban,
  Bell,
  BellOff,
  Check,
  FolderPlus,
  Hash,
  Link2,
  Lock,
  MessageSquareText,
  Plus,
  Settings,
  Tag,
} from "lucide-react"
import { Link } from "react-router-dom"
import { LabelPicker } from "@/components/labels/label-picker"
import { SectionPicker } from "./section-picker"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { MentionIndicator } from "@/components/mention-indicator"
import { DraftIndicator } from "@/components/draft-indicator"
import { RelativeTime } from "@/components/relative-time"
import { getThreadRootContext } from "@/components/thread/breadcrumb-helpers"
import { isDraftId, useActors } from "@/hooks"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { useInputMode } from "@/hooks/use-input-mode"
import { useSidebar } from "@/contexts"
import { useStreamSettings } from "@/components/stream-settings/use-stream-settings"
import { cn } from "@/lib/utils"
import { streamLabel } from "@/lib/streams"
import { streamTypeVisual } from "@/lib/stream-visuals"
import { copyStreamLink } from "@/lib/stream-links"
import { BADGE_CONFIG, URGENCY_COLORS } from "./config"
import {
  SidebarActionContextMenu,
  SidebarActionDrawer,
  SidebarActionMenu,
  type SidebarActionItem,
  type SidebarActionPreview,
} from "./sidebar-actions"
import { useSidebarItemDrawer } from "./use-sidebar-item-drawer"
import { useUrgencyTracking } from "./use-urgency-tracking"
import { StreamLabelDots } from "./sidebar-labels"
import { truncateContent } from "./utils"
import {
  ENCRYPTED_MESSAGE_PREVIEW_LABEL,
  LabelableResourceTypes,
  StreamTypes,
  Visibilities,
  type AuthorType,
  type StreamWithPreview,
} from "@threa/types"
import type { StreamItemData, UrgencyLevel } from "./types"
import { boardScopeStreamId, type SidebarBoardMode } from "./board-sidebar-mode"
import type { BoardStreamStats } from "@/hooks/use-board-sidebar-stats"
import { ScratchpadItem } from "./scratchpad-item"

export type BoardTileState = "included" | "excluded" | "neutral"

/**
 * The board-mode tri-state affordance on a stream row's tile (INV-21 — absolutely
 * positioned, zero layout shift). `included` shows a filled check, `excluded` a
 * ban badge (both always visible as state); `neutral` shows a plus that reveals
 * on hover/touch (the `reveal-actions` pattern). Clicking always toggles include
 * additively — exclude lives in the context menu, not on this control. Rendered
 * inside the tile, so it stops propagation to keep the row's focus-`<Link>` inert.
 */
export function BoardTileToggle({
  state,
  streamName,
  onToggle,
}: {
  state: BoardTileState
  streamName: string
  onToggle: () => void
}) {
  const included = state === "included"
  const excluded = state === "excluded"
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onToggle()
      }}
      aria-pressed={included}
      aria-label={included ? `Remove ${streamName} from board filter` : `Add ${streamName} to board filter`}
      className={cn(
        "absolute -bottom-1 -right-1 z-10 flex h-4 w-4 items-center justify-center rounded-full border ring-2 ring-sidebar transition-colors",
        included && "border-primary bg-primary text-primary-foreground",
        excluded && "border-destructive bg-background text-destructive",
        !included && !excluded && "reveal-actions border-border bg-background text-muted-foreground"
      )}
    >
      {included && <Check className="h-2.5 w-2.5" />}
      {excluded && <Ban className="h-2.5 w-2.5" />}
      {!included && !excluded && <Plus className="h-2.5 w-2.5" />}
    </button>
  )
}

/**
 * The board-mode row preview line: the stream's topic tally in place of the last
 * message ("14 topics · 6 active", "· 2 need resolution" only when > 0, "No
 * topics yet" at zero). Same size/truncation as the message preview it replaces
 * so swapping in board mode shifts nothing (INV-21). `null` stats = the single
 * aggregation hasn't resolved yet; render nothing rather than flash "No topics".
 */
export function BoardStatsLine({ stats }: { stats: BoardStreamStats | null }) {
  if (!stats) return null
  if (stats.topics === 0) {
    return <div className="truncate text-xs text-muted-foreground">No topics yet</div>
  }
  const parts = [`${stats.topics} ${stats.topics === 1 ? "topic" : "topics"}`, `${stats.active} active`]
  if (stats.needsResolution > 0)
    parts.push(`${stats.needsResolution} ${stats.needsResolution === 1 ? "needs" : "need"} resolution`)
  return <div className="truncate text-xs text-muted-foreground">{parts.join(" · ")}</div>
}

export function UrgencyStrip({ urgency }: { urgency: UrgencyLevel }) {
  return (
    <div
      className="w-1 flex-shrink-0 rounded-l-lg transition-colors duration-300"
      style={{ backgroundColor: URGENCY_COLORS[urgency] }}
    />
  )
}

interface StreamItemAvatarProps {
  icon: ReactNode
  className: string
  avatarUrl?: string
  avatarAlt?: string
  badge?: { icon: typeof Hash; color: string } | null
  /**
   * Optional top-right overlay used to surface stream metadata that isn't tied
   * to the thread-root signal — e.g. the AI companion indicator on scratchpads.
   * Renders as a small bordered circle, independent of `badge` (top-left).
   */
  decoration?: { icon: typeof Hash; color: string; ariaLabel?: string } | null
  /** Board-mode tri-state toggle overlaid on the tile's bottom-right corner. Only
   *  supplied for board-scopable rows (non-thread, non-E2E); bottom-right stays
   *  clear of the thread badge (top-left) and the metadata decoration (top-right). */
  boardControl?: ReactNode
}

export function StreamItemAvatar({
  icon,
  className,
  avatarUrl,
  avatarAlt,
  badge,
  decoration,
  boardControl,
}: StreamItemAvatarProps) {
  // Thread-of-DM: thread icon as main content, avatar as small badge overlay
  if (badge && avatarUrl) {
    return (
      <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 relative bg-muted">
        <MessageSquareText className="h-3.5 w-3.5 text-muted-foreground" />
        <Avatar className="absolute -top-1 -left-1 h-3.5 w-3.5 rounded-full border border-border">
          <AvatarImage src={avatarUrl} alt={avatarAlt ?? "User avatar"} />
          <AvatarFallback className="rounded-full text-[6px]">
            <badge.icon className="h-2 w-2" />
          </AvatarFallback>
        </Avatar>
        {decoration && <AvatarDecoration {...decoration} />}
      </div>
    )
  }

  let content = icon
  if (avatarUrl) {
    content = (
      <Avatar className="h-8 w-8 rounded-lg">
        <AvatarImage src={avatarUrl} alt={avatarAlt ?? "User avatar"} />
        <AvatarFallback className="rounded-lg">{icon}</AvatarFallback>
      </Avatar>
    )
  } else if (badge) {
    content = <MessageSquareText className="h-3.5 w-3.5 text-muted-foreground" />
  }

  return (
    <div
      className={cn(
        "w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 relative",
        badge ? "bg-muted" : className
      )}
    >
      {content}
      {badge && (
        <div
          className={cn(
            "absolute -top-1 -left-1 w-3.5 h-3.5 rounded-full bg-background border border-border flex items-center justify-center",
            badge.color
          )}
        >
          <badge.icon className="h-2 w-2" />
        </div>
      )}
      {decoration && <AvatarDecoration {...decoration} />}
      {boardControl}
    </div>
  )
}

function AvatarDecoration({ icon: Icon, color, ariaLabel }: { icon: typeof Hash; color: string; ariaLabel?: string }) {
  return (
    <div
      aria-label={ariaLabel}
      role={ariaLabel ? "img" : undefined}
      className={cn(
        "absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-background border border-border flex items-center justify-center",
        color
      )}
    >
      <Icon className="h-2 w-2" />
    </div>
  )
}

interface StreamItemPreviewProps {
  preview: StreamWithPreview["lastMessagePreview"]
  getActorName: (actorId: string | null, actorType: AuthorType | null) => string
  toEmoji?: (shortcode: string) => string | null
  compact: boolean
  showPreviewOnHover: boolean
  isTouch: boolean
  /**
   * E2E streams: sidebar previews are public surfaces, so we never decrypt
   * here. Phase 3.5 keeps ciphertext at rest and routes decryption through
   * the per-message render hook — show a sentinel in the sidebar so the
   * placeholder zero-width-space wire content never leaks.
   */
  e2eEnabled?: boolean
}

export function StreamItemPreview({
  preview,
  getActorName,
  toEmoji,
  compact,
  showPreviewOnHover,
  isTouch,
  e2eEnabled,
}: StreamItemPreviewProps) {
  if (!preview?.content) return null

  const hoverPreview = compact && showPreviewOnHover && !isTouch

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-xs text-muted-foreground transition-opacity duration-150",
        compact && !hoverPreview && "hidden",
        hoverPreview && "absolute left-0 right-0 top-full z-10 opacity-0 group-hover:opacity-100"
      )}
      aria-hidden={hoverPreview ? "true" : undefined}
    >
      <span className="truncate flex-1">
        {e2eEnabled
          ? `${getActorName(preview.authorId, preview.authorType)}: ${ENCRYPTED_MESSAGE_PREVIEW_LABEL}`
          : `${getActorName(preview.authorId, preview.authorType)}: ${truncateContent(preview.content, 50, toEmoji)}`}
      </span>
      <RelativeTime date={preview.createdAt} className="flex-shrink-0" />
    </div>
  )
}

interface StreamItemProps {
  workspaceId: string
  stream: StreamItemData
  isActive: boolean
  unreadCount: number
  mentionCount: number
  allStreams: StreamItemData[]
  showUrgencyStrip?: boolean
  /** Show compact view (title only, no preview) */
  compact?: boolean
  /** Show preview on hover when compact (only works with compact=true) */
  showPreviewOnHover?: boolean
  /** Reference to scroll container for position tracking */
  scrollContainerRef?: RefObject<HTMLDivElement | null>
  /**
   * A trailing "· home" hint naming where this stream lives (its custom section
   * or pinned label). Set only in the Unread section, where a row is drawn out of
   * its home — so the viewer still sees where it belongs without a duplicate row.
   */
  homeHint?: string
  /** Board-mode descriptor when on `/board` (flag on); `null`/absent in chats
   *  mode, where every board branch below is skipped and the row is unchanged. */
  boardMode?: SidebarBoardMode | null
}

export function StreamItem({
  workspaceId,
  stream,
  isActive,
  unreadCount,
  mentionCount,
  allStreams,
  showUrgencyStrip = true,
  compact = false,
  showPreviewOnHover = false,
  scrollContainerRef,
  homeHint,
  boardMode,
}: StreamItemProps) {
  const { getActorName, getActorAvatar } = useActors(workspaceId)
  const { toEmoji } = useWorkspaceEmoji(workspaceId)
  const { openStreamSettings } = useStreamSettings()
  const { collapseOnMobile } = useSidebar()
  const [labelPickerOpen, setLabelPickerOpen] = useState(false)
  const [sectionPickerOpen, setSectionPickerOpen] = useState(false)
  const itemRef = useRef<HTMLAnchorElement>(null)
  const hasUnread = unreadCount > 0
  const preview = stream.lastMessagePreview
  const isVirtualDraft = isDraftId(stream.id)

  useUrgencyTracking(itemRef, stream.id, stream.urgency, scrollContainerRef)

  // Per-type glyph + tile tint, shared with the board card (single source of
  // truth so the two surfaces can't drift). A DM overlays the peer avatar below.
  const { Icon: TypeIcon, tileClassName } = streamTypeVisual(stream.type)
  const avatar = { icon: <TypeIcon className="h-3.5 w-3.5" />, className: tileClassName }
  const name = streamLabel(stream, "sidebar")
  const threadRootStream =
    stream.type === StreamTypes.THREAD && stream.rootStreamId
      ? (allStreams.find((s) => s.id === stream.rootStreamId) ?? null)
      : null

  const dmPeerAvatar = stream.dmPeerUserId ? getActorAvatar(stream.dmPeerUserId, "user") : null

  const threadRootContext = stream.type === StreamTypes.THREAD ? getThreadRootContext(stream, allStreams) : null

  const threadBadge = (() => {
    if (!threadRootStream?.type) return null
    const config = BADGE_CONFIG[threadRootStream.type]
    return config ?? null
  })()

  // Board scoping is root-oriented (`?in=` matches root ids), so a thread focuses
  // its root, not itself. E2E streams are never on the board (extraction skips
  // them) and threads aren't scopable rows, so the tri-state tile control is
  // limited to non-thread, non-E2E rows; both still keep "Open timeline".
  const isE2e = !!stream.e2eEnabled
  const boardScopeId = boardScopeStreamId(stream)
  const boardScopable = !!boardMode && stream.type !== StreamTypes.THREAD && !isE2e
  const boardIncluded = boardScopable && boardMode.includedStreamIds.has(boardScopeId)
  const boardExcluded = boardScopable && boardMode.excludedStreamIds.has(boardScopeId)
  const boardMuted = boardScopable && boardMode.mutedStreamIds.has(boardScopeId)
  let boardTileState: BoardTileState = "neutral"
  if (boardIncluded) boardTileState = "included"
  else if (boardExcluded) boardTileState = "excluded"

  const boardActions = useMemo<SidebarActionItem[]>(() => {
    if (!boardMode) return []
    const items: SidebarActionItem[] = []
    if (boardScopable) {
      items.push(
        {
          id: "board-filter",
          label: boardIncluded ? "Remove from filter" : "Add to filter",
          icon: Plus,
          onSelect: () => boardMode.applyInclude(boardScopeId),
        },
        {
          id: "board-exclude",
          label: boardExcluded ? "Include again" : "Exclude from board",
          icon: Ban,
          onSelect: () => boardMode.applyExclude(boardScopeId),
        },
        {
          id: "board-mute",
          label: boardMuted ? "Unmute on board" : "Mute on board",
          icon: boardMuted ? Bell : BellOff,
          onSelect: () => boardMode.setMuted(boardScopeId, !boardMuted),
        }
      )
    }
    items.push({
      id: "board-open-timeline",
      label: "Open timeline",
      icon: MessageSquareText,
      href: `/w/${workspaceId}/s/${stream.id}`,
    })
    return items
  }, [boardMode, boardScopable, boardIncluded, boardExcluded, boardMuted, boardScopeId, workspaceId, stream.id])

  const actions = useMemo<SidebarActionItem[]>(() => {
    const base: SidebarActionItem[] = isVirtualDraft
      ? []
      : [
          {
            id: "settings",
            label: "Settings",
            icon: Settings,
            onSelect: () => openStreamSettings(stream.id),
          },
          {
            id: "labels",
            label: "Labels…",
            icon: Tag,
            onSelect: () => setLabelPickerOpen(true),
          },
          {
            id: "copy-link",
            label: "Copy link",
            icon: Link2,
            onSelect: () => void copyStreamLink(workspaceId, stream.id),
          },
          {
            id: "add-to-section",
            label: "Add to section…",
            icon: FolderPlus,
            onSelect: () => setSectionPickerOpen(true),
          },
        ]
    if (boardActions.length === 0) return base
    return [...boardActions, ...base.map((a, i) => (i === 0 ? { ...a, separatorBefore: true } : a))]
  }, [isVirtualDraft, openStreamSettings, stream.id, workspaceId, boardActions])

  let drawerPreview: SidebarActionPreview | null = null
  if (preview?.content) {
    drawerPreview = {
      authorName: getActorName(preview.authorId, preview.authorType),
      content: truncateContent(preview.content, 140, toEmoji),
      createdAt: preview.createdAt,
    }
  } else if (stream.type === StreamTypes.DM) {
    drawerPreview = {
      content: "No messages yet",
    }
  }

  const hasPreviewOnlyDrawer = stream.type === StreamTypes.DM && drawerPreview !== null
  const canOpenDrawer = actions.length > 0 || hasPreviewOnlyDrawer
  const { drawerOpen, setDrawerOpen, handleClick, touchCapable, longPress } = useSidebarItemDrawer({
    canOpenDrawer,
    collapseOnMobile,
  })
  // Presentation (select-none, right-click suppression, hover preview) follows
  // the active input; the long-press gesture follows touch capability above.
  const isTouchInput = useInputMode() === "touch"

  const showHoverPreview = compact && showPreviewOnHover && !isTouchInput && !!preview?.content

  if (stream.type === StreamTypes.SCRATCHPAD) {
    return (
      <ScratchpadItem
        workspaceId={workspaceId}
        stream={stream}
        isActive={isActive}
        unreadCount={unreadCount}
        mentionCount={mentionCount}
        compact={compact}
        showPreviewOnHover={showPreviewOnHover}
        showUrgencyStrip={showUrgencyStrip}
        scrollContainerRef={scrollContainerRef}
        homeHint={homeHint}
        boardMode={boardMode}
      />
    )
  }

  // In board mode the row's verb changes: the `<Link>` focuses the board on this
  // stream (INV-40 — a real navigation), while cmd/ctrl-click intercepts into an
  // additive include. A muted/E2E row swaps its message preview for a board status
  // line; both, plus excluded, dim the row. An E2E row has no board cards
  // (extraction skips it), so its Link opens the timeline rather than focusing an
  // empty scope — the same escape hatch the context menu carries.
  const timelineHref = `/w/${workspaceId}/s/${stream.id}`
  const rowTo = boardMode && !isE2e ? boardMode.focusHref(boardScopeId) : timelineHref
  const handleRowClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (boardScopable && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      boardMode.applyInclude(boardScopeId)
      return
    }
    handleClick(e)
  }
  let boardStatusLine: string | null = null
  if (isE2e && boardMode) boardStatusLine = "Not on the board"
  else if (boardMuted) boardStatusLine = "Muted on the board"
  const boardDimmed = boardExcluded || boardMuted || (isE2e && !!boardMode)

  // The row's second line: a board status line (muted/E2E — takes precedence),
  // else the board topic stats (board mode), else the chats-mode message preview.
  let previewNode: ReactNode
  if (boardStatusLine) {
    previewNode = <div className="text-xs text-muted-foreground">{boardStatusLine}</div>
  } else if (boardMode) {
    previewNode = <BoardStatsLine stats={boardMode.statsForStream(boardScopeId)} />
  } else {
    previewNode = (
      <StreamItemPreview
        preview={preview}
        getActorName={getActorName}
        toEmoji={toEmoji}
        compact={compact}
        showPreviewOnHover={showPreviewOnHover}
        isTouch={isTouchInput}
        e2eEnabled={stream.e2eEnabled}
      />
    )
  }

  return (
    <>
      <SidebarActionContextMenu actions={actions} disabled={isTouchInput} focusRef={itemRef}>
        <div className="group reveal-host relative">
          <Link
            ref={itemRef}
            to={rowTo}
            onClick={handleRowClick}
            onTouchStart={touchCapable ? longPress.handlers.onTouchStart : undefined}
            onTouchEnd={touchCapable ? longPress.handlers.onTouchEnd : undefined}
            onTouchMove={touchCapable ? longPress.handlers.onTouchMove : undefined}
            onContextMenu={touchCapable ? longPress.handlers.onContextMenu : undefined}
            className={cn(
              "flex items-stretch rounded-lg text-sm transition-colors",
              // The tinted background means exactly one thing: "you are here" — or,
              // in board mode, "included in the scope". Unread is signaled by the
              // bold title + urgency strip — a near-identical primary tint made
              // unread rows read as active.
              isActive || boardIncluded ? "bg-primary/10" : "hover:bg-muted/50",
              boardDimmed && "opacity-50",
              isTouchInput && canOpenDrawer && "select-none",
              longPress.isPressed && "opacity-70 transition-opacity duration-100"
            )}
          >
            {showUrgencyStrip && <UrgencyStrip urgency={stream.urgency} />}

            <div className="flex items-center gap-2.5 flex-1 min-w-0 px-2 py-2">
              <StreamItemAvatar
                icon={avatar.icon}
                className={avatar.className}
                avatarUrl={dmPeerAvatar?.avatarUrl}
                avatarAlt={name}
                badge={threadBadge}
                boardControl={
                  boardScopable ? (
                    <BoardTileToggle
                      state={boardTileState}
                      streamName={name}
                      onToggle={() => boardMode.applyInclude(boardScopeId)}
                    />
                  ) : undefined
                }
              />

              <div
                className={cn(
                  "relative flex flex-col flex-1 min-w-0 gap-0.5 transition-transform duration-150",
                  showHoverPreview && "group-hover:-translate-y-[0.3125rem]"
                )}
              >
                <div className="flex items-center gap-2 pr-8">
                  <span
                    className={cn(
                      "truncate text-sm",
                      hasUnread ? "font-semibold" : "font-medium",
                      // The truncation ellipsis inherits the color of this element. When a grey trailing
                      // context (parent stream, or the Unread "· home" hint) trails the title it's the usual
                      // cut point, so tint the container grey (and keep the title itself at foreground) so the
                      // ellipsis matches the text it's shortening.
                      (threadRootContext || homeHint) && "text-muted-foreground/60"
                    )}
                  >
                    {threadRootContext || homeHint ? <span className="text-foreground">{name}</span> : name}
                    {threadRootContext && <span className="font-normal text-xs"> · {threadRootContext}</span>}
                    {!threadRootContext && homeHint && <span className="font-normal text-xs"> · {homeHint}</span>}
                  </span>
                  {stream.type === StreamTypes.CHANNEL && stream.visibility === Visibilities.PRIVATE && (
                    <Lock className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                  )}
                  {boardMuted && (
                    <BellOff className="h-3 w-3 shrink-0 text-muted-foreground/60" aria-label="Muted on the board" />
                  )}
                  <div className="ml-auto flex items-center gap-1.5">
                    <StreamLabelDots streamId={stream.id} />
                    {/* Suppressed on the active stream — its composer already shows the draft. */}
                    {stream.hasLoadedDraft && !isActive && <DraftIndicator />}
                    <MentionIndicator count={mentionCount} />
                  </div>
                </div>
                {previewNode}
              </div>
            </div>
          </Link>

          <SidebarActionMenu actions={actions} ariaLabel="Stream actions" />
        </div>
      </SidebarActionContextMenu>
      {labelPickerOpen && (
        <LabelPicker
          workspaceId={workspaceId}
          resourceType={LabelableResourceTypes.STREAM}
          resourceId={stream.id}
          open
          onOpenChange={setLabelPickerOpen}
        />
      )}
      {sectionPickerOpen && (
        <SectionPicker workspaceId={workspaceId} streamId={stream.id} open onOpenChange={setSectionPickerOpen} />
      )}
      {touchCapable && canOpenDrawer && (
        <SidebarActionDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          actions={actions}
          streamName={name}
          title={`Actions for ${name}`}
          description="Choose an action for this stream."
          preview={drawerPreview}
        />
      )}
    </>
  )
}
