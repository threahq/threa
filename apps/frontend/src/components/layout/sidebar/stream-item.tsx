import { useMemo, useRef, useState, type ReactNode, type RefObject } from "react"
import { FolderPlus, Hash, Link2, Lock, MessageSquareText, Settings, Tag } from "lucide-react"
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
import { ScratchpadItem } from "./scratchpad-item"

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
}

export function StreamItemAvatar({ icon, className, avatarUrl, avatarAlt, badge, decoration }: StreamItemAvatarProps) {
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

  const actions = useMemo<SidebarActionItem[]>(
    () =>
      isVirtualDraft
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
          ],
    [isVirtualDraft, openStreamSettings, stream.id, workspaceId]
  )

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
      />
    )
  }

  return (
    <>
      <SidebarActionContextMenu actions={actions} disabled={isTouchInput} focusRef={itemRef}>
        <div className="group reveal-host relative">
          <Link
            ref={itemRef}
            to={`/w/${workspaceId}/s/${stream.id}`}
            onClick={handleClick}
            onTouchStart={touchCapable ? longPress.handlers.onTouchStart : undefined}
            onTouchEnd={touchCapable ? longPress.handlers.onTouchEnd : undefined}
            onTouchMove={touchCapable ? longPress.handlers.onTouchMove : undefined}
            onContextMenu={touchCapable ? longPress.handlers.onContextMenu : undefined}
            className={cn(
              "flex items-stretch rounded-lg text-sm transition-colors",
              // The tinted background means exactly one thing: "you are here".
              // Unread is signaled by the bold title + urgency strip — giving it
              // a near-identical primary tint made unread rows read as active.
              isActive ? "bg-primary/10" : "hover:bg-muted/50",
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
                  <div className="ml-auto flex items-center gap-1.5">
                    <StreamLabelDots streamId={stream.id} />
                    {/* Suppressed on the active stream — its composer already shows the draft. */}
                    {stream.hasLoadedDraft && !isActive && <DraftIndicator />}
                    <MentionIndicator count={mentionCount} />
                  </div>
                </div>
                <StreamItemPreview
                  preview={preview}
                  getActorName={getActorName}
                  toEmoji={toEmoji}
                  compact={compact}
                  showPreviewOnHover={showPreviewOnHover}
                  isTouch={isTouchInput}
                  e2eEnabled={stream.e2eEnabled}
                />
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
