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
  Sparkles,
  Moon,
  Lock,
  Tag,
  Link2,
  Layers,
  ChevronDown,
} from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { DraftAgentSettings } from "@/components/stream-settings/draft-agent-settings"
import { LiveAgentSettings } from "@/components/stream-settings/live-agent-settings"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  SidebarActionDrawer,
  SidebarActionMenu,
  type SidebarActionItem,
} from "@/components/layout/sidebar/sidebar-actions"
import { cn } from "@/lib/utils"
import { useStreamOrDraft, useStreamError, usePanelLayout, isDmDraftId, useTypeToFocus } from "@/hooks"
import { useWorkspaceDmPeers, useWorkspaceMetadata } from "@/stores/workspace-store"
import { usePanel, useSidebar } from "@/contexts"
import { useUserProfile } from "@/components/user-profile"
import { useStreamSettings } from "@/components/stream-settings/use-stream-settings"
import { useExplorerUrlState } from "@/components/attachment-explorer"
import { TimelineView } from "@/components/timeline"
import { LabelPicker } from "@/components/labels/label-picker"
import { StreamLabelStack } from "@/components/labels/stream-label-stack"
import { StreamHeaderEncryptionAction } from "@/components/encryption/stream-encryption-affordance"
import { StreamEncryptionGate } from "@/components/encryption/stream-encryption-gate"
import { useDecryptedStreamName, useStreamNameDecrypting } from "@/hooks/use-decrypted-stream-name"
import { Skeleton } from "@/components/ui/skeleton"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useE2eSession } from "@/stores/e2e-session-store"
import { StreamPanel, ThreadHeader } from "@/components/thread"
import { ThreadPanelSlot, SidebarToggle } from "@/components/layout"
import { ConversationList } from "@/components/conversations"
import { StreamErrorView } from "@/components/stream-error-view"
import { InviteActorButton } from "@/components/encryption"
import { CompanionModes, LabelableResourceTypes, StreamTypes, type StreamType } from "@threa/types"
import { getStreamName, streamFallbackLabel, streamLabel } from "@/lib/streams"
import { copyStreamLink } from "@/lib/stream-links"
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
  const { panelId, isPanelOpen, closePanel, setFocusedPane } = usePanel()
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

  // Conversation overlay: colors timeline rows by conversation membership
  // (rendered by StreamContent, which reads the same param — INV-59).
  const isConversationOverlayOn = searchParams.get("convOverlay") === "on"

  const setConversationOverlayOn = (on: boolean) => {
    setSearchParams(
      (prev) => {
        const newParams = new URLSearchParams(prev)
        if (on) {
          newParams.set("convOverlay", "on")
        } else {
          newParams.delete("convOverlay")
        }
        return newParams
      },
      // The overlay is ephemeral view chrome, not navigation: every toggle
      // path replaces (the panel's X in stream-content.tsx does too), so Back
      // leaves the stream instead of silently toggling chrome. The URL still
      // updates for refresh/share (INV-59).
      { replace: true }
    )
  }

  const { openUserProfile } = useUserProfile()
  const { openStreamSettings } = useStreamSettings()
  const { open: openExplorer } = useExplorerUrlState()
  const dmPeers = useWorkspaceDmPeers(workspaceId ?? "")
  const workspaceMetadata = useWorkspaceMetadata(workspaceId ?? "")
  // For an unlocked encrypted stream, the tamper-evident decrypted name; null
  // otherwise (plaintext stream, locked, or not yet decrypted) → plaintext label.
  const decryptedStreamName = useDecryptedStreamName(workspaceId ?? "", stream)
  // True while a sealed name is still resolving (session settling, or unlocked
  // but the decrypt hasn't landed) so the header shows a loader instead of
  // flashing the "unnamed" placeholder on cold load.
  const nameDecrypting = useStreamNameDecrypting(workspaceId ?? "", stream)
  // Renaming an E2E stream seals the new name under its key, so it requires an
  // unlocked session — the affordance is omitted while locked (the stream is in
  // its locked/unlock state then anyway).
  const currentUserId = useWorkspaceUserId(workspaceId ?? "")
  const e2eUnlocked = useE2eSession(workspaceId ?? "", currentUserId ?? "").status === "unlocked"

  const isThread = stream?.type === StreamTypes.THREAD
  const isChannel = stream?.type === StreamTypes.CHANNEL
  const isDm = stream?.type === StreamTypes.DM
  const dmPeerUserId = isDm ? dmPeers.find((p) => p.streamId === streamId)?.userId : null

  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState("")
  // The just-submitted name, held while the rename is in flight so the header
  // shows it continuously instead of dipping to the persisted name during the
  // network round-trip. Cleared once the write lands (the decrypt cache is seeded
  // by then, so it resolves straight to the new name).
  const [pendingName, setPendingName] = useState<string | null>(null)
  const [isMenuDrawerOpen, setIsMenuDrawerOpen] = useState(false)
  const [labelPickerOpen, setLabelPickerOpen] = useState(false)
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
  const isEncryptedScratchpad = isScratchpad && !!stream?.e2eEnabled
  const isArchived = stream?.archivedAt != null
  const isDmDraft = isDraft && isDmDraftId(streamId)
  let streamName = "Stream"
  if (stream) {
    streamName = pendingName ?? decryptedStreamName ?? streamLabel(stream)
  } else if (isDraft) {
    streamName = streamFallbackLabel(isDmDraft ? "dm" : "scratchpad", "sidebar")
  }

  // Pre-fill (and no-op-guard) the rename against the name the header actually
  // shows: for an encrypted stream that's the client-decrypted name, which can
  // differ from the server-stored `displayName`. Seeding with `displayName`
  // would surprise the user with a stale/placeholder value (UX-35).
  const currentDisplayedName = decryptedStreamName ?? stream?.displayName ?? ""

  // Renaming a sealed scratchpad needs an unlocked session to seal the new name;
  // a non-encrypted scratchpad can always be renamed. Gate every rename affordance
  // (header title click and menu item) on this so a locked session can't open the
  // editor only for `rename()` to reject on seal.
  const canRenameScratchpad = !isEncryptedScratchpad || e2eUnlocked

  const handleStartRename = () => {
    if (!canRenameScratchpad) return
    setEditValue(currentDisplayedName)
    setIsEditing(true)
  }

  const handleSaveRename = async () => {
    const trimmed = editValue.trim()
    setIsEditing(false)

    if (!trimmed || trimmed === currentDisplayedName) return

    setPendingName(trimmed)
    try {
      await rename(trimmed)
    } catch (err) {
      console.error("Failed to rename stream", err)
    } finally {
      setPendingName(null)
    }
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
  streamMenuActions.push({
    id: "labels",
    label: "Labels…",
    icon: Tag,
    onSelect: () => setLabelPickerOpen(true),
  })
  streamMenuActions.push({
    id: "copy-link",
    label: "Copy link",
    icon: Link2,
    onSelect: () => void copyStreamLink(workspaceId, streamId),
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
    // Hide the rename affordance while locked rather than let it fall back to
    // plaintext. Archive/unarchive stay available regardless of lock state.
    if (canRenameScratchpad) {
      streamMenuActions.push({
        id: "rename",
        label: "Rename",
        icon: Pencil,
        onSelect: handleStartRename,
        separatorBefore: streamMenuActions.length > 0,
      })
    }
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

  // Scratchpad mode indicator. Three shapes share one pill slot:
  //   - Encrypted (E2E): Lock + "Encrypted" — companion mode is locked off
  //     server-side (INV-E1), so the lock is the more meaningful signal.
  //   - Companion: Sparkles + "Companion" — Ariadne replies to new messages.
  //   - Quiet: Moon + "Quiet" — silent capture, no AI replies.
  // Drafts get an inert variant because the settings dialog reads from caches
  // that don't have draft entries yet; the pill becomes interactive once the
  // scratchpad is persisted. (E2E scratchpads are never drafts — they're
  // server-persisted on creation, with no displayName until the user names
  // them, which is exactly why we render the pill on unnamed scratchpads too:
  // for encrypted ones the lock IS the only signal of their nature.)
  let companionModeIndicator: React.ReactNode = null
  if (stream && isScratchpad) {
    const isEncrypted = !!stream.e2eEnabled
    const isOn = !isEncrypted && stream.companionMode === CompanionModes.ON

    let Icon: typeof Sparkles
    let modeLabel: string
    let pillVariant: string
    let hoverVariant: string
    let iconTint: string
    let interactiveAria: string

    if (isEncrypted) {
      Icon = Lock
      modeLabel = "Encrypted"
      pillVariant = "border-border bg-secondary text-foreground"
      hoverVariant = "hover:bg-accent"
      iconTint = "text-muted-foreground"
      interactiveAria = "End-to-end encrypted. Companion and tool settings."
    } else if (isOn) {
      Icon = Sparkles
      modeLabel = "Companion"
      pillVariant = "border-primary/30 bg-primary/5 text-foreground"
      hoverVariant = "hover:bg-primary/10"
      iconTint = "text-primary"
      interactiveAria = "Companion is on. Click to change companion mode and tool access."
    } else {
      Icon = Moon
      modeLabel = "Quiet"
      pillVariant = "border-border bg-secondary text-muted-foreground"
      hoverVariant = "hover:bg-accent hover:text-foreground"
      iconTint = ""
      interactiveAria = "Quiet mode. Click to change companion mode and tool access."
    }

    const pillBase = "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold"

    // One in-flow popover for both drafts and live scratchpads: companion mode
    // and (owner-only) tool access. The trailing chevron + hover state make the
    // pill read as a control. Drafts write to the local draft (the settings
    // dialog can't be used pre-create); live scratchpads use live mutations.
    companionModeIndicator = (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={interactiveAria}
            className={cn(
              pillBase,
              pillVariant,
              "cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              hoverVariant
            )}
          >
            <Icon className={cn("h-3 w-3", iconTint)} aria-hidden="true" />
            <span>{modeLabel}</span>
            <ChevronDown className="h-3 w-3 -mr-0.5 opacity-60" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80">
          {isDraft ? (
            <DraftAgentSettings
              workspaceId={workspaceId!}
              draftId={streamId!}
              companionMode={stream.companionMode}
              allowedToolCategories={stream.allowedToolCategories ?? null}
              configuredCategories={workspaceMetadata?.configuredToolCategories}
            />
          ) : (
            <LiveAgentSettings
              workspaceId={workspaceId!}
              streamId={streamId!}
              companionMode={stream.companionMode}
              e2e={isEncrypted}
            />
          )}
        </PopoverContent>
      </Popover>
    )
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
        className={cn(
          "group inline-flex items-center gap-1 rounded-md px-2 py-1 -ml-2 transition-colors min-w-0",
          canRenameScratchpad
            ? "cursor-pointer hover:bg-accent/50 hover:outline hover:outline-1 hover:outline-border"
            : "cursor-default"
        )}
        onClick={canRenameScratchpad ? handleStartRename : undefined}
      >
        {nameDecrypting && !pendingName ? (
          <Skeleton className="h-5 w-40" />
        ) : (
          <h1 className="font-semibold truncate">
            {streamName}
            {isDraft && <span className="ml-2 text-xs font-normal text-muted-foreground">(draft)</span>}
          </h1>
        )}
        {canRenameScratchpad && (
          <Pencil className="h-3.5 w-3.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
        )}
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
          {companionModeIndicator}
          {stream && !isDraft && <StreamLabelStack workspaceId={workspaceId} streamId={streamId} />}
          {isEncryptedScratchpad && !isDraft && (
            <StreamHeaderEncryptionAction workspaceId={workspaceId} encrypted streamId={streamId} />
          )}
          {stream && isScratchpad && !isDraft && (
            <InviteActorButton workspaceId={workspaceId!} stream={stream} kind="enclave" />
          )}
          {stream && !isThread && !isScratchpad && !isChannel && !isDraft && (
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
            // Split button (the `GroupedItem` pattern from message-context-menu):
            // primary tap toggles the conversation overlay; the chevron lists
            // every conversation view — overlay first (default, font-medium),
            // then the slide-out conversations list.
            <div className="flex items-stretch">
              <Button
                variant="ghost"
                size="icon"
                className={cn("h-8 w-8 rounded-r-none", isConversationOverlayOn && "bg-accent text-accent-foreground")}
                title="Conversation overlay"
                // Stable accessible name; on/off state is announced via
                // aria-pressed (ARIA toggle-button pattern), so the label
                // must not flip with the state.
                aria-label="Conversation overlay"
                aria-pressed={isConversationOverlayOn}
                onClick={() => setConversationOverlayOn(!isConversationOverlayOn)}
              >
                <Layers className="h-4 w-4" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    // Wider on touch viewports — a 20px chevron is fiddly with
                    // a finger; desktop keeps the compact split-button look.
                    className="h-8 w-7 rounded-l-none border-l border-border/50 px-0 sm:w-5"
                    aria-label="Other conversation views"
                  >
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[200px]">
                  <DropdownMenuItem
                    className="gap-2 cursor-pointer font-medium"
                    onSelect={() => setConversationOverlayOn(!isConversationOverlayOn)}
                  >
                    <Layers className="h-4 w-4 text-muted-foreground" />
                    Conversation overlay
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="gap-2 cursor-pointer"
                    onSelect={() => setConversationViewOpen(!isConversationViewOpen)}
                  >
                    <MessageCircle className="h-4 w-4 text-muted-foreground" />
                    Conversations list
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
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
        <StreamEncryptionGate workspaceId={workspaceId} encrypted={isEncryptedScratchpad && !isDraft}>
          <TimelineView isDraft={isDraft} autoFocus={!isMobile} />
        </StreamEncryptionGate>
      </main>
      {stream && !isDraft && (
        <LabelPicker
          workspaceId={workspaceId}
          resourceType={LabelableResourceTypes.STREAM}
          resourceId={streamId}
          open={labelPickerOpen}
          onOpenChange={setLabelPickerOpen}
        />
      )}
    </div>
  )

  // Conversation side panel - shown for channels and DMs
  const conversationPanel = (isChannel || isDm) && (
    <>
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/80 transition-opacity duration-300",
          isConversationViewOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        onClick={() => setConversationViewOpen(false)}
      />
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
        <div
          className="flex-1 min-w-0 overflow-hidden"
          onPointerDownCapture={() => setFocusedPane("main")}
          onFocusCapture={() => setFocusedPane("main")}
        >
          {mainStreamContent}
        </div>

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
