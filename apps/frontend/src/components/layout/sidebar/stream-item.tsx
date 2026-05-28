import { useMemo, useRef, useState, type ReactNode, type RefObject } from "react"
import { Bell, FileEdit, Hash, Lock, MessageSquareText, Settings, Tag, User } from "lucide-react"
import { Link } from "react-router-dom"
import { LabelPicker } from "@/components/labels/label-picker"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { MentionIndicator } from "@/components/mention-indicator"
import { RelativeTime } from "@/components/relative-time"
import { getThreadRootContext } from "@/components/thread/breadcrumb-helpers"
import { isDraftId, useActors } from "@/hooks"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { useSidebar } from "@/contexts"
import { useStreamSettings } from "@/components/stream-settings/use-stream-settings"
import { cn } from "@/lib/utils"
import { streamLabel } from "@/lib/streams"
import { BADGE_CONFIG, URGENCY_COLORS } from "./config"
import {
  SidebarActionDrawer,
  SidebarActionMenu,
  type SidebarActionItem,
  type SidebarActionPreview,
} from "./sidebar-actions"
import { useSidebarItemDrawer } from "./use-sidebar-item-drawer"
import { useUrgencyTracking } from "./use-urgency-tracking"
import { truncateContent } from "./utils"
import {
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
  isMobile: boolean
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
  isMobile,
  e2eEnabled,
}: StreamItemPreviewProps) {
  if (!preview?.content) return null

  const hoverPreview = compact && showPreviewOnHover && !isMobile

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
          ? `${getActorName(preview.authorId, preview.authorType)}: 🔒 Encrypted message`
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
}: StreamItemProps) {
  const { getActorName, getActorAvatar } = useActors(workspaceId)
  const { toEmoji } = useWorkspaceEmoji(workspaceId)
  const { openStreamSettings } = useStreamSettings()
  const { collapseOnMobile } = useSidebar()
  const [labelPickerOpen, setLabelPickerOpen] = useState(false)
  const itemRef = useRef<HTMLAnchorElement>(null)
  const hasUnread = unreadCount > 0
  const preview = stream.lastMessagePreview
  const isVirtualDraft = isDraftId(stream.id)

  useUrgencyTracking(itemRef, stream.id, stream.urgency, scrollContainerRef)

  // Determine avatar content based on stream type
  const getAvatar = () => {
    if (stream.type === StreamTypes.CHANNEL) {
      return {
        icon: <Hash className="h-3.5 w-3.5" />,
        className: "bg-muted text-[hsl(200_60%_50%)]",
      }
    }
    if (stream.type === StreamTypes.SCRATCHPAD) {
      return {
        icon: <FileEdit className="h-3.5 w-3.5" />,
        className: "bg-primary/10 text-primary",
      }
    }
    if (stream.type === StreamTypes.SYSTEM) {
      return {
        icon: <Bell className="h-3.5 w-3.5" />,
        className: "bg-blue-500/10 text-blue-500",
      }
    }
    if (stream.type === StreamTypes.THREAD) {
      return {
        icon: <MessageSquareText className="h-3.5 w-3.5" />,
        className: "bg-muted text-muted-foreground",
      }
    }
    // DM
    return {
      icon: <User className="h-3.5 w-3.5" />,
      className: "bg-muted text-muted-foreground",
    }
  }

  const avatar = getAvatar()
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
          ],
    [isVirtualDraft, openStreamSettings, stream.id]
  )

  let drawerPreview: SidebarActionPreview | null = null
  if (preview?.content) {
    drawerPreview = {
      streamName: name,
      authorName: getActorName(preview.authorId, preview.authorType),
      content: truncateContent(preview.content, 140, toEmoji),
      createdAt: preview.createdAt,
    }
  } else if (stream.type === StreamTypes.DM) {
    drawerPreview = {
      streamName: name,
      content: "No messages yet",
    }
  }

  const hasPreviewOnlyDrawer = stream.type === StreamTypes.DM && drawerPreview !== null
  const canOpenDrawer = actions.length > 0 || hasPreviewOnlyDrawer
  const { drawerOpen, setDrawerOpen, handleClick, isMobile, longPress } = useSidebarItemDrawer({
    canOpenDrawer,
    collapseOnMobile,
  })

  const showHoverPreview = compact && showPreviewOnHover && !isMobile && !!preview?.content

  // For scratchpads, support renaming
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
      />
    )
  }

  return (
    <>
      <div className="group relative">
        <Link
          ref={itemRef}
          to={`/w/${workspaceId}/s/${stream.id}`}
          onClick={handleClick}
          onTouchStart={isMobile ? longPress.handlers.onTouchStart : undefined}
          onTouchEnd={isMobile ? longPress.handlers.onTouchEnd : undefined}
          onTouchMove={isMobile ? longPress.handlers.onTouchMove : undefined}
          onContextMenu={isMobile ? longPress.handlers.onContextMenu : undefined}
          className={cn(
            "flex items-stretch rounded-lg text-sm transition-colors",
            isActive ? "bg-primary/10" : "hover:bg-muted/50",
            hasUnread && !isActive && "bg-primary/5 hover:bg-primary/10",
            isMobile && canOpenDrawer && "select-none",
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
                <span className={cn("truncate text-sm", hasUnread ? "font-semibold" : "font-medium")}>
                  {name}
                  {threadRootContext && (
                    <span className="font-normal text-muted-foreground/60 text-xs"> · {threadRootContext}</span>
                  )}
                </span>
                {stream.type === StreamTypes.CHANNEL && stream.visibility === Visibilities.PRIVATE && (
                  <Lock className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                )}
                <MentionIndicator count={mentionCount} className="ml-auto" />
              </div>
              <StreamItemPreview
                preview={preview}
                getActorName={getActorName}
                toEmoji={toEmoji}
                compact={compact}
                showPreviewOnHover={showPreviewOnHover}
                isMobile={isMobile}
                e2eEnabled={stream.e2eEnabled}
              />
            </div>
          </div>
        </Link>

        <SidebarActionMenu actions={actions} ariaLabel="Stream actions" />
      </div>
      {labelPickerOpen && (
        <LabelPicker
          workspaceId={workspaceId}
          resourceType={LabelableResourceTypes.STREAM}
          resourceId={stream.id}
          open
          onOpenChange={setLabelPickerOpen}
        />
      )}
      {isMobile && canOpenDrawer && (
        <SidebarActionDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          actions={actions}
          title={`Actions for ${name}`}
          description="Choose an action for this stream."
          preview={drawerPreview}
        />
      )}
    </>
  )
}
