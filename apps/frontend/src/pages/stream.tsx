import { useState, useRef, useEffect } from "react"
import { useParams, useSearchParams } from "react-router-dom"
import {
  MoreHorizontal,
  Pencil,
  Archive,
  MessageCircle,
  X,
  ArchiveX,
  Search,
  CornerDownRight,
  Paperclip,
  Settings,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  SidebarActionDrawer,
  SidebarActionMenu,
  type SidebarActionItem,
} from "@/components/layout/sidebar/sidebar-actions"
import { cn } from "@/lib/utils"
import { useStreamOrDraft, useStreamError, usePanelLayout, isDmDraftId, useTypeToFocus } from "@/hooks"
import { useWorkspaceDmPeers } from "@/stores/workspace-store"
import { usePanel, useSidebar } from "@/contexts"
import { useUserProfile } from "@/components/user-profile"
import { useStreamSettings } from "@/components/stream-settings/use-stream-settings"
import { useExplorerUrlState } from "@/components/attachment-explorer"
import { TimelineView } from "@/components/timeline"
import { StreamPanel, ThreadHeader } from "@/components/thread"
import { ThreadPanelSlot, SidebarToggle } from "@/components/layout"
import { ConversationList } from "@/components/conversations"
import { StreamErrorView } from "@/components/stream-error-view"
import { StreamTypes, type StreamType } from "@threa/types"
import { getStreamName, streamFallbackLabel, streamLabel } from "@/lib/streams"
import { setPageStreamName } from "@/lib/page-title"
import { dispatchStartBatchSelect } from "@/lib/batch-selection-events"

function getStreamTypeLabel(type: StreamType): string {
  switch (type) {
    case StreamTypes.SCRATCHPAD:
      return "Scratchpad"
    case StreamTypes.CHANNEL:
      return "Channel"
    case StreamTypes.DM:
      return "DM"
    case StreamTypes.THREAD:
      return "Thread"
    default:
      return type
  }
}

export function StreamPage() {
  const { workspaceId, streamId } = useParams<{ workspaceId: string; streamId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const { stream, isDraft, error, rename, archive, unarchive } = useStreamOrDraft(workspaceId!, streamId!)
  const { isMobile } = useSidebar()
  const { panelId, isPanelOpen, closePanel } = usePanel()
  const {
    containerRef,
    panelWidth,
    maxWidth,
    minWidth,
    displayWidth,
    shouldAnimate,
    isResizing,
    showContent,
    handleResizeStart,
    handleResizeKeyDown,
    handleTransitionEnd,
  } = usePanelLayout(isPanelOpen)

  useTypeToFocus()

  // Unified error checking - checks both coordinated loading and direct query errors
  const streamError = useStreamError(streamId, error)

  const isConversationViewOpen = searchParams.get("convView") === "open"

  const setConversationViewOpen = (open: boolean) => {
    setSearchParams((prev) => {
      const newParams = new URLSearchParams(prev)
      if (open) {
        newParams.set("convView", "open")
      } else {
        newParams.delete("convView")
      }
      return newParams
    })
  }

  const { openUserProfile } = useUserProfile()
  const { openStreamSettings } = useStreamSettings()
  const { open: openExplorer } = useExplorerUrlState()
  const dmPeers = useWorkspaceDmPeers(workspaceId ?? "")

  const isThread = stream?.type === StreamTypes.THREAD
  const isChannel = stream?.type === StreamTypes.CHANNEL
  const isDm = stream?.type === StreamTypes.DM
  const dmPeerUserId = isDm ? dmPeers.find((p) => p.streamId === streamId)?.userId : null

  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState("")
  const [isMenuDrawerOpen, setIsMenuDrawerOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // `stream.displayName` is already viewer-resolved by useStreamOrDraft (DM peer
  // names included), so the page title just reads the shared name off it.
  useEffect(() => {
    if (!stream) {
      setPageStreamName(null)
      return () => setPageStreamName(null)
    }
    setPageStreamName(getStreamName(stream))
    return () => setPageStreamName(null)
  }, [stream])

  if (!workspaceId || !streamId) {
    return null
  }

  // Show error page if stream has error (404/403)
  if (streamError) {
    return <StreamErrorView type={streamError.type} workspaceId={workspaceId} />
  }

  const isScratchpad = stream?.type === StreamTypes.SCRATCHPAD
  const isArchived = stream?.archivedAt != null
  const isDmDraft = isDraft && isDmDraftId(streamId)
  let streamName = "Stream"
  if (stream) {
    streamName = streamLabel(stream)
  } else if (isDraft) {
    streamName = streamFallbackLabel(isDmDraft ? "dm" : "scratchpad", "sidebar")
  }
  const isUnnamedScratchpad = isScratchpad && !stream?.displayName

  const handleStartRename = () => {
    setEditValue(stream?.displayName ?? "")
    setIsEditing(true)
  }

  const handleSaveRename = async () => {
    const trimmed = editValue.trim()
    setIsEditing(false)

    if (!trimmed || trimmed === stream?.displayName) return

    await rename(trimmed)
  }

  const handleArchive = async () => {
    await archive()
  }

  const handleUnarchive = async () => {
    await unarchive?.()
  }

  const handleSelectMessages = () => {
    dispatchStartBatchSelect(streamId)
  }

  // System streams are read-only on the backend (e.g. activity/notification
  // feeds) — surfacing "Move messages…" there would be a guaranteed dead
  // end since the move endpoints reject the source stream.
  const isSystem = stream?.type === StreamTypes.SYSTEM
  const streamMenuActions: SidebarActionItem[] = []
  streamMenuActions.push({
    id: "stream-settings",
    label: "Settings",
    icon: Settings,
    onSelect: () => openStreamSettings(streamId),
  })
  if (!isArchived && !isSystem) {
    streamMenuActions.push({
      id: "move-messages",
      label: "Move messages…",
      icon: CornerDownRight,
      onSelect: handleSelectMessages,
      separatorBefore: true,
    })
  }
  streamMenuActions.push({
    id: "browse-files",
    label: "Browse files…",
    icon: Paperclip,
    onSelect: () => openExplorer({ streamIds: [streamId] }),
  })
  if (isScratchpad) {
    streamMenuActions.push({
      id: "rename",
      label: "Rename",
      icon: Pencil,
      onSelect: handleStartRename,
      separatorBefore: streamMenuActions.length > 0,
    })
    streamMenuActions.push(
      isArchived
        ? {
            id: "unarchive",
            label: "Unarchive",
            icon: Archive,
            onSelect: handleUnarchive,
            separatorBefore: true,
          }
        : {
            id: "archive",
            label: "Archive",
            icon: Archive,
            onSelect: handleArchive,
            variant: "destructive",
            separatorBefore: true,
          }
    )
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSaveRename()
    } else if (e.key === "Escape") {
      setIsEditing(false)
    }
  }

  let headerTitle: React.ReactNode
  if (isEditing) {
    headerTitle = (
      <Input
        ref={inputRef}
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={handleSaveRename}
        onKeyDown={handleKeyDown}
        className="h-8 max-w-xs font-semibold"
        placeholder="Scratchpad name"
        autoFocus
      />
    )
  } else if (isThread && stream) {
    headerTitle = <ThreadHeader workspaceId={workspaceId} stream={stream} />
  } else if (isScratchpad) {
    headerTitle = (
      <div
        className="group inline-flex items-center gap-1 rounded-md px-2 py-1 -ml-2 hover:bg-accent/50 hover:outline hover:outline-1 hover:outline-border cursor-pointer transition-colors min-w-0"
        onClick={handleStartRename}
      >
        <h1 className="font-semibold truncate">
          {streamName}
          {isDraft && <span className="ml-2 text-xs font-normal text-muted-foreground">(draft)</span>}
        </h1>
        <Pencil className="h-3.5 w-3.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    )
  } else if (isDm && dmPeerUserId) {
    headerTitle = (
      <button
        type="button"
        onClick={() => openUserProfile(dmPeerUserId)}
        className="font-semibold truncate hover:underline text-left"
      >
        {streamName}
      </button>
    )
  } else {
    headerTitle = <h1 className="font-semibold truncate">{streamName}</h1>
  }

  const mainStreamContent = (
    <div className="flex h-full flex-col">
      <header className="flex h-12 items-center justify-between border-b px-4">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <SidebarToggle location="page" />
          {headerTitle}
          {stream && !isThread && !isDraft && !isChannel && !isUnnamedScratchpad && (
            <Badge variant="secondary">{getStreamTypeLabel(stream.type)}</Badge>
          )}
          {isArchived && (
            <Badge variant="secondary" className="gap-1">
              <ArchiveX className="h-3 w-3" />
              Archived
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1 ml-1">
          {!isThread && !isDraft && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              title="Search in conversation"
              onClick={() => document.dispatchEvent(new CustomEvent("threa:open-stream-search"))}
            >
              <Search className="h-4 w-4" />
            </Button>
          )}
          {(isChannel || isDm) && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              title="Conversations"
              onClick={() => setConversationViewOpen(!isConversationViewOpen)}
            >
              <MessageCircle className="h-4 w-4" />
            </Button>
          )}
          {stream &&
            !isDraft &&
            !(isArchived && !isScratchpad) &&
            (isMobile ? (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="Stream actions"
                  onClick={() => setIsMenuDrawerOpen(true)}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
                <SidebarActionDrawer
                  open={isMenuDrawerOpen}
                  onOpenChange={setIsMenuDrawerOpen}
                  actions={streamMenuActions}
                  title="Stream actions"
                  description="Choose an action for this stream."
                  header={
                    <div className="px-4 pt-2 pb-3">
                      <p className="truncate text-base font-semibold text-foreground">{streamName}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {stream ? getStreamTypeLabel(stream.type) : "Stream"} actions
                      </p>
                    </div>
                  }
                />
              </>
            ) : (
              <SidebarActionMenu
                actions={streamMenuActions}
                ariaLabel="Stream actions"
                trigger={
                  <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Stream actions">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                }
              />
            ))}
        </div>
      </header>
      <main className="relative flex-1 overflow-hidden" data-editor-zone="main">
        <TimelineView isDraft={isDraft} autoFocus={!isMobile} />
      </main>
    </div>
  )

  // Conversation side panel - shown for channels and DMs
  const conversationPanel = (isChannel || isDm) && (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/80 transition-opacity duration-300",
          isConversationViewOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        onClick={() => setConversationViewOpen(false)}
      />
      {/* Panel */}
      <div
        className={cn(
          "fixed inset-y-0 right-0 z-50 w-full sm:w-96 bg-background border-l shadow-lg flex flex-col",
          "transition-transform duration-300 ease-out",
          isConversationViewOpen ? "translate-x-0" : "translate-x-full"
        )}
      >
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">Conversations</h2>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setConversationViewOpen(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <ConversationList
            workspaceId={workspaceId!}
            streamId={streamId!}
            onMessageClick={() => setConversationViewOpen(false)}
          />
        </div>
      </div>
    </>
  )

  // On mobile, thread panel takes over the full screen
  if (isMobile && isPanelOpen) {
    return (
      <>
        <div className="flex h-full flex-col">
          <StreamPanel key={panelId} workspaceId={workspaceId} onClose={closePanel} />
        </div>
        {conversationPanel}
      </>
    )
  }

  return (
    <>
      <div ref={containerRef} className="flex h-full">
        <div className="flex-1 min-w-0 overflow-hidden">{mainStreamContent}</div>

        <ThreadPanelSlot
          displayWidth={displayWidth}
          panelWidth={panelWidth}
          shouldAnimate={shouldAnimate}
          showContent={showContent}
          isResizing={isResizing}
          maxWidth={maxWidth}
          minWidth={minWidth}
          onTransitionEnd={handleTransitionEnd}
          onResizeStart={handleResizeStart}
          onResizeKeyDown={handleResizeKeyDown}
        >
          <StreamPanel key={panelId} workspaceId={workspaceId} onClose={closePanel} />
        </ThreadPanelSlot>
      </div>
      {conversationPanel}
    </>
  )
}
