import { useCallback, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react"
import {
  Archive,
  Ban,
  Bell,
  BellOff,
  FileEdit,
  FolderPlus,
  Link2,
  ListChecks,
  Lock,
  MessageSquareText,
  Paperclip,
  Plus,
  Settings,
  Sparkles,
  Tag,
} from "lucide-react"
import { Link, useNavigate } from "react-router-dom"
import { LabelPicker } from "@/components/labels/label-picker"
import { useExplorerUrlState } from "@/components/attachment-explorer"
import { useOutcomesUrlState } from "@/components/agent-outcomes"
import { SectionPicker } from "./section-picker"
import { MentionIndicator } from "@/components/mention-indicator"
import { DraftIndicator } from "@/components/draft-indicator"
import { isDraftId, useActors, useArchiveStream, useDraftScratchpads } from "@/hooks"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { useInputMode } from "@/hooks/use-input-mode"
import { useSidebar } from "@/contexts"
import { useStreamSettings } from "@/components/stream-settings/use-stream-settings"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { streamFallbackLabel } from "@/lib/streams"
import { copyStreamLink } from "@/lib/stream-links"
import { CompanionModes, LabelableResourceTypes } from "@threa/types"
import { useUrgencyTracking } from "./use-urgency-tracking"
import {
  SidebarActionContextMenu,
  SidebarActionDrawer,
  SidebarActionMenu,
  type SidebarActionItem,
  type SidebarActionPreview,
} from "./sidebar-actions"
import {
  UrgencyStrip,
  StreamItemAvatar,
  StreamItemPreview,
  BoardTileToggle,
  BoardStatsLine,
  AgentActivityPreviewLine,
  agentActivityLabel,
  type BoardTileState,
} from "./stream-item"
import { useAgentActivityForStream } from "@/stores/agent-activity-store"
import { StreamLabelDots } from "./sidebar-labels"
import { useSidebarItemDrawer } from "./use-sidebar-item-drawer"
import { truncateContent } from "./utils"
import type { SidebarBoardMode } from "./board-sidebar-mode"
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
  /** Trailing "· home" hint — set only in the Unread section. See {@link StreamItem}. */
  homeHint?: string
  /** Board-mode descriptor when on `/board` (flag on); `null`/absent in chats mode. */
  boardMode?: SidebarBoardMode | null
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
  homeHint,
  boardMode,
}: ScratchpadItemProps) {
  const navigate = useNavigate()
  const archiveStream = useArchiveStream(workspaceId)
  const { deleteScratchpad } = useDraftScratchpads(workspaceId)
  const { getActorName } = useActors(workspaceId)
  const { toEmoji } = useWorkspaceEmoji(workspaceId)
  const { collapseOnMobile } = useSidebar()
  const { openStreamSettings } = useStreamSettings()
  const { open: openExplorer } = useExplorerUrlState()
  const { open: openOutcomes } = useOutcomesUrlState()
  const itemRef = useRef<HTMLAnchorElement>(null)
  const [labelPickerOpen, setLabelPickerOpen] = useState(false)
  const [sectionPickerOpen, setSectionPickerOpen] = useState(false)
  const hasUnread = unreadCount > 0
  const isDraft = isDraftId(streamWithPreview.id)
  const agentSessions = useAgentActivityForStream(workspaceId, streamWithPreview.id)
  const agentActive = agentSessions.length > 0

  const currentDisplayName = streamWithPreview.displayName ?? null
  const name = currentDisplayName || streamFallbackLabel("scratchpad", "sidebar")
  // Resolved once by the stream-list builder off the shared name cache, so the
  // row shows a loader (not the "New scratchpad" placeholder) while an encrypted
  // scratchpad's sealed name is still decrypting on cold load — same treatment as
  // the open-stream header.
  const nameDecrypting = streamWithPreview.nameDecrypting ?? false
  const preview = streamWithPreview.lastMessagePreview

  // Board mode re-aims the row (see {@link StreamItem}). A scratchpad is a board
  // root, so it scopes by its own id — unless it's an unsaved draft (no
  // conversations yet) or E2E (extraction skips it), where the tri-state control
  // and filter verbs are withheld.
  const isE2e = !!streamWithPreview.e2eEnabled
  const boardScopable = !!boardMode && !isDraft && !isE2e
  const boardIncluded = boardScopable && boardMode.includedStreamIds.has(streamWithPreview.id)
  const boardExcluded = boardScopable && boardMode.excludedStreamIds.has(streamWithPreview.id)
  const boardMuted = boardScopable && boardMode.mutedStreamIds.has(streamWithPreview.id)
  let boardTileState: BoardTileState = "neutral"
  if (boardIncluded) boardTileState = "included"
  else if (boardExcluded) boardTileState = "excluded"

  useUrgencyTracking(itemRef, streamWithPreview.id, streamWithPreview.urgency, scrollContainerRef)

  const handleArchive = useCallback(async () => {
    if (isDraft) {
      await deleteScratchpad(streamWithPreview.id)
      // Drafts are fully deleted — navigate away if viewing
      if (isActive) {
        navigate(`/w/${workspaceId}`)
      }
    } else {
      // Real streams stay viewable as read-only after archival
      await archiveStream.mutateAsync(streamWithPreview.id)
    }
  }, [archiveStream, deleteScratchpad, isActive, isDraft, navigate, streamWithPreview.id, workspaceId])

  const boardActions = useMemo<SidebarActionItem[]>(() => {
    if (!boardMode) return []
    const items: SidebarActionItem[] = []
    if (boardScopable) {
      items.push(
        {
          id: "board-filter",
          label: boardIncluded ? "Remove from filter" : "Add to filter",
          icon: Plus,
          onSelect: () => boardMode.applyInclude(streamWithPreview.id),
        },
        {
          id: "board-exclude",
          label: boardExcluded ? "Include again" : "Exclude from board",
          icon: Ban,
          onSelect: () => boardMode.applyExclude(streamWithPreview.id),
        },
        {
          id: "board-mute",
          label: boardMuted ? "Unmute on board" : "Mute on board",
          icon: boardMuted ? Bell : BellOff,
          onSelect: () => boardMode.setMuted(streamWithPreview.id, !boardMuted),
        }
      )
    }
    items.push({
      id: "board-open-timeline",
      label: "Open timeline",
      icon: MessageSquareText,
      href: `/w/${workspaceId}/s/${streamWithPreview.id}`,
    })
    return items
  }, [boardMode, boardScopable, boardIncluded, boardExcluded, boardMuted, streamWithPreview.id, workspaceId])

  const actions = useMemo<SidebarActionItem[]>(
    () => [
      ...boardActions,
      ...(!isDraft
        ? [
            {
              id: "settings",
              label: "Settings",
              icon: Settings,
              onSelect: () => openStreamSettings(streamWithPreview.id),
              separatorBefore: boardActions.length > 0,
            } satisfies SidebarActionItem,
            {
              id: "labels",
              label: "Labels…",
              icon: Tag,
              onSelect: () => setLabelPickerOpen(true),
            } satisfies SidebarActionItem,
            {
              id: "copy-link",
              label: "Copy link",
              icon: Link2,
              onSelect: () => void copyStreamLink(workspaceId, streamWithPreview.id),
            } satisfies SidebarActionItem,
            {
              id: "browse-files",
              label: "Browse files…",
              icon: Paperclip,
              onSelect: () => openExplorer({ streamIds: [streamWithPreview.id] }),
            } satisfies SidebarActionItem,
            {
              id: "view-outcomes",
              label: "Agent agenda…",
              icon: ListChecks,
              onSelect: () => openOutcomes({ streamIds: [streamWithPreview.id] }),
            } satisfies SidebarActionItem,
            {
              id: "add-to-section",
              label: "Add to section…",
              icon: FolderPlus,
              onSelect: () => setSectionPickerOpen(true),
            } satisfies SidebarActionItem,
          ]
        : []),
      {
        id: "archive",
        label: isDraft ? "Delete" : "Archive",
        icon: Archive,
        onSelect: handleArchive,
        variant: "destructive",
        separatorBefore: !isDraft || boardActions.length > 0,
      },
    ],
    [
      handleArchive,
      isDraft,
      openStreamSettings,
      openExplorer,
      openOutcomes,
      streamWithPreview.id,
      workspaceId,
      boardActions,
    ]
  )

  const drawerPreview: SidebarActionPreview | null =
    preview && preview.content
      ? {
          authorName: getActorName(preview.authorId, preview.authorType),
          content: truncateContent(preview.content, 140, toEmoji),
          createdAt: preview.createdAt,
        }
      : null

  const { drawerOpen, setDrawerOpen, handleClick, touchCapable, longPress } = useSidebarItemDrawer({
    canOpenDrawer: actions.length > 0,
    collapseOnMobile,
  })
  // Presentation (select-none, right-click suppression, hover preview) follows
  // the active input; the long-press gesture follows touch capability above.
  const isTouchInput = useInputMode() === "touch"

  const showHoverPreview = compact && showPreviewOnHover && !isTouchInput && !!preview?.content

  // E2E and companion-on are mutually exclusive (INV-E1 forces companion off
  // server-side for encrypted streams), so a single decoration slot is enough
  // — lock takes priority when both shapes could theoretically apply.
  let decoration: { icon: typeof Lock; color: string; ariaLabel: string } | null = null
  if (streamWithPreview.e2eEnabled) {
    decoration = { icon: Lock, color: "text-muted-foreground", ariaLabel: "Encrypted scratchpad" }
  } else if (streamWithPreview.companionMode === CompanionModes.ON) {
    decoration = { icon: Sparkles, color: "text-primary", ariaLabel: "AI companion attached" }
  }

  // An E2E scratchpad has no board cards (extraction skips it), so its Link opens
  // the timeline rather than focusing an empty scope. See {@link StreamItem}.
  const timelineHref = `/w/${workspaceId}/s/${streamWithPreview.id}`
  const rowTo = boardMode && !isE2e ? boardMode.focusHref(streamWithPreview.id) : timelineHref
  const handleRowClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (boardScopable && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      boardMode.applyInclude(streamWithPreview.id)
      return
    }
    handleClick(e)
  }
  // Mute-skip parity with StreamItem: an active `?in=` include overrides the
  // board mute, so the muted dim + status line yield to the include state.
  let boardStatusLine: string | null = null
  if (isE2e && boardMode) boardStatusLine = "Not on the board"
  else if (boardMuted && !boardIncluded) boardStatusLine = "Muted on the board"
  const boardDimmed = boardExcluded || (boardMuted && !boardIncluded) || (isE2e && !!boardMode)

  // Second line: board status (muted/E2E — precedence), else board topic stats,
  // else the chats-mode message preview. See {@link StreamItem}.
  let previewNode: ReactNode
  if (boardStatusLine) {
    previewNode = <div className="text-xs text-muted-foreground">{boardStatusLine}</div>
  } else if (boardMode) {
    previewNode = <BoardStatsLine stats={boardMode.statsForStream(streamWithPreview.id)} />
  } else if (agentActive) {
    previewNode = (
      <AgentActivityPreviewLine label={agentActivityLabel(agentSessions[0]?.personaName, agentSessions.length)} />
    )
  } else {
    previewNode = (
      <StreamItemPreview
        preview={preview}
        getActorName={getActorName}
        toEmoji={toEmoji}
        compact={compact}
        showPreviewOnHover={showPreviewOnHover}
        isTouch={isTouchInput}
        e2eEnabled={streamWithPreview.e2eEnabled}
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
              // in board mode, "included in the scope". See StreamItem; unread is
              // the bold title + urgency strip.
              isActive || boardIncluded ? "bg-primary/10" : "hover:bg-muted/50",
              boardDimmed && "opacity-50",
              isTouchInput && actions.length > 0 && "select-none",
              longPress.isPressed && "opacity-70 transition-opacity duration-100"
            )}
          >
            {showUrgencyStrip && <UrgencyStrip urgency={streamWithPreview.urgency} />}

            <div className="flex items-center gap-2.5 flex-1 min-w-0 px-2 py-2">
              <StreamItemAvatar
                icon={<FileEdit className="h-3.5 w-3.5" />}
                className="bg-primary/10 text-primary"
                decoration={decoration}
                agentActive={agentActive}
              />

              <div
                className={cn(
                  "relative flex flex-col flex-1 min-w-0 gap-0.5 transition-transform duration-150",
                  showHoverPreview && "group-hover:-translate-y-[0.3125rem]"
                )}
              >
                {/* Right reserve for the hover "…" menu only — see StreamItem. */}
                <div className={cn("flex items-center gap-2", !isTouchInput && "pr-8")}>
                  {nameDecrypting ? (
                    <Skeleton className="h-4 w-28" />
                  ) : (
                    <span className={cn("truncate text-sm", hasUnread ? "font-semibold" : "font-medium")}>
                      {name}
                      {isDraft && <span className="ml-1.5 text-xs text-muted-foreground font-normal">(draft)</span>}
                      {homeHint && <span className="text-xs text-muted-foreground font-normal"> · {homeHint}</span>}
                    </span>
                  )}
                  {boardMuted && (
                    <BellOff className="h-3 w-3 shrink-0 text-muted-foreground/60" aria-label="Muted on the board" />
                  )}
                  <div className="ml-auto flex items-center gap-1.5">
                    <StreamLabelDots streamId={streamWithPreview.id} />
                    {/* Suppressed on the active stream — its composer already shows the draft. */}
                    {streamWithPreview.hasLoadedDraft && !isActive && <DraftIndicator />}
                    <MentionIndicator count={mentionCount} />
                  </div>
                </div>
                {previewNode}
              </div>
            </div>
          </Link>

          {/* Sibling of the Link (button-in-anchor is invalid); positioned over the
              tile's bottom-right corner — see StreamItem. */}
          {boardScopable && (
            <BoardTileToggle
              state={boardTileState}
              streamName={name}
              onToggle={() => boardMode.applyInclude(streamWithPreview.id)}
              className={cn("top-[calc(50%+0.25rem)]", showUrgencyStrip ? "left-8" : "left-7")}
            />
          )}

          <SidebarActionMenu actions={actions} ariaLabel="Stream actions" />
        </div>
      </SidebarActionContextMenu>
      {labelPickerOpen && (
        <LabelPicker
          workspaceId={workspaceId}
          resourceType={LabelableResourceTypes.STREAM}
          resourceId={streamWithPreview.id}
          open
          onOpenChange={setLabelPickerOpen}
        />
      )}
      {sectionPickerOpen && (
        <SectionPicker
          workspaceId={workspaceId}
          streamId={streamWithPreview.id}
          open
          onOpenChange={setSectionPickerOpen}
        />
      )}
      {touchCapable && actions.length > 0 && (
        <SidebarActionDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          actions={actions}
          streamName={isDraft ? `${name} (draft)` : name}
          title={`Actions for ${name}`}
          description="Choose an action for this stream."
          preview={drawerPreview}
        />
      )}
    </>
  )
}
