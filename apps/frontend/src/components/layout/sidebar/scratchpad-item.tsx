import { useCallback, useMemo, useRef, type RefObject } from "react"
import { Archive, FileEdit, Settings } from "lucide-react"
import { Link, useNavigate } from "react-router-dom"
import { MentionIndicator } from "@/components/mention-indicator"
import { isDraftId, useActors, useArchiveStream, useDraftScratchpads } from "@/hooks"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { useSidebar } from "@/contexts"
import { useStreamSettings } from "@/components/stream-settings/use-stream-settings"
import { cn } from "@/lib/utils"
import { streamFallbackLabel } from "@/lib/streams"
import { useUrgencyTracking } from "./use-urgency-tracking"
import {
  SidebarActionDrawer,
  SidebarActionMenu,
  type SidebarActionItem,
  type SidebarActionPreview,
} from "./sidebar-actions"
import { UrgencyStrip, StreamItemAvatar, StreamItemPreview } from "./stream-item"
import { useSidebarItemDrawer } from "./use-sidebar-item-drawer"
import { truncateContent } from "./utils"
import type { StreamItemData } from "./types"

interface ScratchpadItemProps {
  workspaceId: string
  stream: StreamItemData
  isActive: boolean
  unreadCount: number
  mentionCount: number
  showUrgencyStrip?: boolean
  compact?: boolean
  showPreviewOnHover?: boolean
  scrollContainerRef?: RefObject<HTMLDivElement | null>
}

export function ScratchpadItem({
  workspaceId,
  stream: streamWithPreview,
  isActive,
  unreadCount,
  mentionCount,
  showUrgencyStrip = true,
  compact = false,
  showPreviewOnHover = false,
  scrollContainerRef,
}: ScratchpadItemProps) {
  const navigate = useNavigate()
  const archiveStream = useArchiveStream(workspaceId)
  const { deleteDraft } = useDraftScratchpads(workspaceId)
  const { getActorName } = useActors(workspaceId)
  const { toEmoji } = useWorkspaceEmoji(workspaceId)
  const { collapseOnMobile } = useSidebar()
  const { openStreamSettings } = useStreamSettings()
  const itemRef = useRef<HTMLAnchorElement>(null)
  const hasUnread = unreadCount > 0
  const isDraft = isDraftId(streamWithPreview.id)

  const currentDisplayName = streamWithPreview.displayName ?? null
  const name = currentDisplayName || streamFallbackLabel("scratchpad", "sidebar")
  const preview = streamWithPreview.lastMessagePreview

  useUrgencyTracking(itemRef, streamWithPreview.id, streamWithPreview.urgency, scrollContainerRef)

  const handleArchive = useCallback(async () => {
    if (isDraft) {
      await deleteDraft(streamWithPreview.id)
      // Drafts are fully deleted — navigate away if viewing
      if (isActive) {
        navigate(`/w/${workspaceId}`)
      }
    } else {
      // Real streams stay viewable as read-only after archival
      await archiveStream.mutateAsync(streamWithPreview.id)
    }
  }, [archiveStream, deleteDraft, isActive, isDraft, navigate, streamWithPreview.id, workspaceId])

  const actions = useMemo<SidebarActionItem[]>(
    () => [
      ...(!isDraft
        ? [
            {
              id: "settings",
              label: "Settings",
              icon: Settings,
              onSelect: () => openStreamSettings(streamWithPreview.id),
            } satisfies SidebarActionItem,
          ]
        : []),
      {
        id: "archive",
        label: isDraft ? "Delete" : "Archive",
        icon: Archive,
        onSelect: handleArchive,
        variant: "destructive",
        separatorBefore: !isDraft,
      },
    ],
    [handleArchive, isDraft, openStreamSettings, streamWithPreview.id]
  )

  const drawerPreview: SidebarActionPreview | null =
    preview && preview.content
      ? {
          streamName: isDraft ? `${name} (draft)` : name,
          authorName: getActorName(preview.authorId, preview.authorType),
          content: truncateContent(preview.content, 140, toEmoji),
          createdAt: preview.createdAt,
        }
      : null

  const { drawerOpen, setDrawerOpen, handleClick, isMobile, longPress } = useSidebarItemDrawer({
    canOpenDrawer: actions.length > 0,
    collapseOnMobile,
  })

  const showHoverPreview = compact && showPreviewOnHover && !isMobile && !!preview?.content

  return (
    <>
      <div className="group relative">
        <Link
          ref={itemRef}
          to={`/w/${workspaceId}/s/${streamWithPreview.id}`}
          onClick={handleClick}
          onTouchStart={isMobile ? longPress.handlers.onTouchStart : undefined}
          onTouchEnd={isMobile ? longPress.handlers.onTouchEnd : undefined}
          onTouchMove={isMobile ? longPress.handlers.onTouchMove : undefined}
          onContextMenu={isMobile ? longPress.handlers.onContextMenu : undefined}
          className={cn(
            "flex items-stretch rounded-lg text-sm transition-colors",
            isActive ? "bg-primary/10" : "hover:bg-muted/50",
            hasUnread && !isActive && "bg-primary/5 hover:bg-primary/10",
            isMobile && actions.length > 0 && "select-none",
            longPress.isPressed && "opacity-70 transition-opacity duration-100"
          )}
        >
          {showUrgencyStrip && <UrgencyStrip urgency={streamWithPreview.urgency} />}

          <div className="flex items-center gap-2.5 flex-1 min-w-0 px-2 py-2">
            <StreamItemAvatar icon={<FileEdit className="h-3.5 w-3.5" />} className="bg-primary/10 text-primary" />

            <div
              className={cn(
                "relative flex flex-col flex-1 min-w-0 gap-0.5 transition-transform duration-150",
                showHoverPreview && "group-hover:-translate-y-[0.3125rem]"
              )}
            >
              <div className="flex items-center gap-2 pr-8">
                <span className={cn("truncate text-sm", hasUnread ? "font-semibold" : "font-medium")}>
                  {name}
                  {isDraft && <span className="ml-1.5 text-xs text-muted-foreground font-normal">(draft)</span>}
                </span>
                <MentionIndicator count={mentionCount} className="ml-auto" />
              </div>
              <StreamItemPreview
                preview={preview}
                getActorName={getActorName}
                toEmoji={toEmoji}
                compact={compact}
                showPreviewOnHover={showPreviewOnHover}
                isMobile={isMobile}
                e2eEnabled={streamWithPreview.e2eEnabled}
              />
            </div>
          </div>
        </Link>

        <SidebarActionMenu actions={actions} ariaLabel="Stream actions" />
      </div>
      {isMobile && actions.length > 0 && (
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
