import { useState, useRef, useEffect } from "react"
import { toast } from "sonner"
import { useParams, useSearchParams } from "react-router-dom"
import {
  ListChecks,
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
  PanelRight,
  ChevronDown,
  UserRound,
} from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { DraftAgentSettings } from "@/components/stream-settings/draft-agent-settings"
import { LiveAgentSettings } from "@/components/stream-settings/live-agent-settings"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { SidebarActionMenu, type SidebarActionItem } from "@/components/layout/sidebar/sidebar-actions"
import { cn } from "@/lib/utils"
import { floatingPanelTab } from "@/lib/panel-tabs"
import {
  useStreamOrDraft,
  useStreamError,
  usePanelLayout,
  isDmDraftId,
  useTypeToFocus,
  useActiveBotPresence,
} from "@/hooks"
import { useWorkspaceDmPeers, useWorkspaceMetadata } from "@/stores/workspace-store"
import { usePanel, useSidebar } from "@/contexts"
import { useUserProfile } from "@/components/user-profile"
import { useStreamSettings } from "@/components/stream-settings/use-stream-settings"
import { useExplorerUrlState } from "@/components/attachment-explorer"
import { useOutcomesUrlState } from "@/components/agent-outcomes"
import { TimelineView, AgentActivityHeaderChip } from "@/components/timeline"
import { LabelPicker } from "@/components/labels/label-picker"
import { LabelStack } from "@/components/labels/label-stack"
import { StreamHeaderEncryptionAction } from "@/components/encryption/stream-encryption-affordance"
import { StreamEncryptionGate } from "@/components/encryption/stream-encryption-gate"
import { useDecryptedStreamName, useStreamNameDecrypting } from "@/hooks/use-decrypted-stream-name"
import { Skeleton } from "@/components/ui/skeleton"
import { useFeatureFlag } from "@/hooks/use-feature-flags"
import { CallStartMenu, RejoinBar } from "@/components/call"
import { ThreadHeader } from "@/components/thread"
import { ResizablePanelFrame, SidebarToggle, StreamTitlePreview, usePanelInset } from "@/components/layout"
import { PaneHost, Pane } from "@/components/panes"
import {
  AsideColumn,
  AsideCoversPanesContext,
  AsideMobileSheet,
  asideColumnFits,
  useAsideColumnLayout,
  useAsideHost,
  useAsideIsSheet,
} from "@/components/aside"
import { AsideHeaderChip } from "@/components/aside/aside-header-chip"
import { asideHoldsPanel, useAsideForHost } from "@/stores/aside-store"
import { PanelTabStack } from "@/components/layout/panel-host"
import { PaneShortcuts } from "@/components/layout/pane-shortcuts"
import { useInputMode } from "@/hooks/use-input-mode"
import { useCoverClose } from "@/hooks/use-cover-close"
import { CONVERSATION_OVERLAY_COVER } from "@/lib/covers"
import { ConversationList } from "@/components/conversations"
import { StreamErrorView } from "@/components/stream-error-view"
import { InviteActorButton, InviteBotButton } from "@/components/encryption"
import { BotRuntimeStatuses, CompanionModes, LabelableResourceTypes, StreamTypes } from "@threahq/types"
import { getStreamName, getStreamTypeLabel, streamFallbackLabel, streamLabel } from "@/lib/streams"
import { StreamSheet } from "@/components/stream-sheet"
import { SharedWithBadge } from "@/components/shared-with-badge"
import { useStreamContextToggle } from "@/components/stream-context"
import { MIN_PANEL_WIDTH } from "@/hooks/use-panel-layout"
import { useElementWidth } from "@/hooks/use-element-width"
import { copyStreamLink } from "@/lib/stream-links"
import { setPageStreamName } from "@/lib/page-title"
import { dispatchStartBatchSelect } from "@/lib/batch-selection-events"

export function StreamPage() {
  const { workspaceId, streamId } = useParams<{ workspaceId: string; streamId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const { stream, isDraft, error, rename, canRename, renamePending, renameError, archive, unarchive } =
    useStreamOrDraft(workspaceId!, streamId!)
  const { isMobile } = useSidebar()
  const { panelId, isPanelOpen, layout, setCurrentPane } = usePanel()
  const [isContextOpen, toggleContext] = useStreamContextToggle(streamId!)
  const containerRef = useRef<HTMLDivElement>(null)
  const mainPaneRef = useRef<HTMLDivElement>(null)
  const containerWidth = useElementWidth(containerRef)
  const asideHostKey = useAsideHost()
  // A sheet over the page on a phone, or where the columns leave it no room; anywhere else a column of it.
  const asideSheetOnly = useAsideIsSheet()
  const asideIsSheet = asideSheetOnly || !asideColumnFits(containerWidth, isPanelOpen ? MIN_PANEL_WIDTH : 0)
  const openAside = useAsideForHost(asideHostKey)
  const asideColumn = asideIsSheet ? null : openAside
  // A thread the sheet holds is mounted there and nowhere else: not in the
  // slot, not as the phone's takeover behind the sheet.
  const panelInAside = asideIsSheet && openAside !== null && asideHoldsPanel(panelId, openAside.hostStreamId)
  // The aside clamps against the other columns' minimums.
  const asideLayout = useAsideColumnLayout(asideColumn, containerWidth, isPanelOpen ? MIN_PANEL_WIDTH : 0)
  const {
    panelWidth,
    maxWidth,
    minWidth,
    displayWidth,
    shouldAnimate,
    isResizing,
    showContent,
    handleResizeStart,
    handleResizeMove,
    handleResizeEnd,
    handleResizeKeyDown,
    handleTransitionEnd,
    maxColumns,
  } = usePanelLayout(isPanelOpen && !panelInAside, {
    containerRef,
    columns: layout.columns.length,
    reservedWidth: asideLayout.width,
    animates: !isMobile,
  })

  useTypeToFocus()

  // Unified error checking - checks both coordinated loading and direct query errors
  const streamError = useStreamError(streamId, error)

  const panelInset = displayWidth + asideLayout.width
  const panelInsetAnimates = shouldAnimate && !asideLayout.isResizing
  // Above the error/early returns: a stream that turns inaccessible mid-session
  // must not change this component's hook count.
  usePanelInset(isMobile || streamError ? 0 : panelInset, panelInsetAnimates)

  const isConversationViewOpen = searchParams.get("convView") === "open"
  // The closed drawer stays in the DOM for its slide transition, but its list
  // re-renders on every conversation update, so it mounts only while shown.
  const [conversationListMounted, setConversationListMounted] = useState(isConversationViewOpen)
  if (isConversationViewOpen && !conversationListMounted) setConversationListMounted(true)

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

  // Turning it on pushes so back turns it off; off pops that entry when it is
  // what lies beneath (the panel's X in stream-content.tsx closes the same way).
  const closeConversationOverlay = useCoverClose(CONVERSATION_OVERLAY_COVER)
  const setConversationOverlayOn = (on: boolean) => {
    if (!on) {
      closeConversationOverlay()
      return
    }
    setSearchParams((prev) => {
      const newParams = new URLSearchParams(prev)
      newParams.set("convOverlay", "on")
      return newParams
    })
  }

  const { openUserProfile } = useUserProfile()
  const { openStreamSettings } = useStreamSettings()
  const { open: openExplorer } = useExplorerUrlState()
  const { open: openOutcomes } = useOutcomesUrlState()
  const dmPeers = useWorkspaceDmPeers(workspaceId ?? "")
  const workspaceMetadata = useWorkspaceMetadata(workspaceId ?? "")
  // For an unlocked encrypted stream, the tamper-evident decrypted name; null
  // otherwise (plaintext stream, locked, or not yet decrypted) → plaintext label.
  const decryptedStreamName = useDecryptedStreamName(workspaceId ?? "", stream)
  // True while a sealed name is still resolving (session settling, or unlocked
  // but the decrypt hasn't landed) so the header shows a loader instead of
  // flashing the "unnamed" placeholder on cold load.
  const nameDecrypting = useStreamNameDecrypting(workspaceId ?? "", stream)
  useEffect(() => {
    if (renameError) toast.error(renameError.message)
  }, [renameError])
  // An external agent (e.g. a Pi remote bot runtime) attached to this
  // scratchpad. Drives the "External" pill state and its connection dot.
  // Called here (above the early returns below) to keep hook order stable.
  const activeBotPresence = useActiveBotPresence(workspaceId, streamId)

  const callsEnabled = useFeatureFlag(workspaceId ?? "", "calls") === "on"

  const isThread = stream?.type === StreamTypes.THREAD
  const isChannel = stream?.type === StreamTypes.CHANNEL
  const isDm = stream?.type === StreamTypes.DM
  const dmPeerUserId = isDm ? dmPeers.find((p) => p.streamId === streamId)?.userId : null

  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState("")
  // Touch-only: the title bar is chrome (title, type/archived pills, label
  // stack), so a finger-hold should reveal/act, never text-select it — but a
  // mouse may still select to copy the name, and the rename input must stay
  // selectable while editing.
  const isTouchInput = useInputMode() === "touch"
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
    // An unnamed scratchpad takes the same fallback the draft branch below and
    // the sidebar use, so promoting a draft doesn't retitle the header from
    // "New scratchpad" to "Untitled" before the generated name lands.
    streamName = pendingName ?? decryptedStreamName ?? streamLabel(stream, isScratchpad ? "sidebar" : "generic")
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
  const canRenameScratchpad = canRename

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
    dispatchStartBatchSelect(streamId, "moveToThread")
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
  streamMenuActions.push({
    id: "view-outcomes",
    label: "Agent agenda…",
    icon: ListChecks,
    onSelect: () => openOutcomes({ streamIds: [streamId] }),
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

  // Mobile stream sheet: view surfaces that are inline header icons on desktop
  // (context panel, conversation views, DM profile) become sheet rows.
  const sheetViewActions: SidebarActionItem[] = []
  if (isMobile) {
    if (isDm && dmPeerUserId) {
      sheetViewActions.push({
        id: "view-profile",
        label: "View profile",
        icon: UserRound,
        onSelect: () => openUserProfile(dmPeerUserId),
      })
    }
    if (!isDraft) {
      sheetViewActions.push({
        id: "stream-context",
        label: "In this stream",
        description: "Links, files & memories",
        icon: PanelRight,
        onSelect: toggleContext,
      })
    }
    if (isChannel || isDm) {
      sheetViewActions.push({
        id: "conversation-overlay",
        label: "Conversation overlay",
        description: isConversationOverlayOn ? "On — tap to turn off" : null,
        icon: Layers,
        onSelect: () => setConversationOverlayOn(!isConversationOverlayOn),
      })
      sheetViewActions.push({
        id: "conversations-list",
        label: "Conversations list",
        icon: MessageCircle,
        onSelect: () => setConversationViewOpen(true),
      })
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSaveRename()
    } else if (e.key === "Escape") {
      setIsEditing(false)
    }
  }

  // Scratchpad mode indicator. Four shapes share one pill slot:
  //   - Encrypted (E2E): Lock + "Encrypted" — companion mode is locked off
  //     server-side (INV-E1), and the unlock affordance only renders while
  //     locked, so this pill is the persistent encryption signal: it wins.
  //   - External: connection dot + "External" — an external agent (e.g. a Pi
  //     remote bot runtime) is attached. The dot is green when the runtime is
  //     connected (available/busy), grey otherwise. Lives in the header so the
  //     live status doesn't float over the timeline and collide with the date pill.
  //   - Companion: Sparkles + "Companion" — Ariadne replies to new messages.
  //   - Quiet: Moon + "Quiet" — silent capture, no AI replies.
  // Drafts get an inert variant because the settings dialog reads from caches
  // that don't have draft entries yet; the pill becomes interactive once the
  // scratchpad is persisted. (E2E scratchpads are never drafts — they're
  // server-persisted on creation, with no displayName until the user names
  // them, which is exactly why we render the pill on unnamed scratchpads too:
  // for encrypted ones the lock IS the only signal of their nature.)
  const externalConnected =
    activeBotPresence?.presence?.status === BotRuntimeStatuses.AVAILABLE ||
    activeBotPresence?.presence?.status === BotRuntimeStatuses.BUSY

  // On mobile the pill's content lives in the stream sheet instead — the bar
  // keeps only a tiny state glyph beside the name. Drafts keep the pill (the
  // sheet reads live caches that have no draft entries).
  let companionModeIndicator: React.ReactNode = null
  if (stream && isScratchpad && (!isMobile || isDraft)) {
    const isEncrypted = !!stream.e2eEnabled
    const isExternal = !isEncrypted && !!activeBotPresence
    const isOn = !isEncrypted && !isExternal && stream.companionMode === CompanionModes.ON

    let leadingVisual: React.ReactNode
    let modeLabel: string
    let pillVariant: string
    let hoverVariant: string
    let interactiveAria: string
    // Encrypted collapses to a bare lock — the word "Encrypted" is redundant
    // next to it and the header is tight. The other states keep their label.
    let iconOnly = false

    if (isEncrypted) {
      leadingVisual = <Lock className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
      modeLabel = "Encrypted"
      pillVariant = "border-border bg-secondary text-foreground"
      hoverVariant = "hover:bg-accent"
      interactiveAria = "End-to-end encrypted. Companion and tool settings."
      iconOnly = true
    } else if (isExternal) {
      leadingVisual = (
        <span
          className={cn(
            "inline-block size-2 shrink-0 rounded-full",
            externalConnected ? "bg-emerald-500" : "bg-muted-foreground/40"
          )}
          aria-hidden="true"
        />
      )
      modeLabel = "External"
      pillVariant = "border-border bg-secondary text-foreground"
      hoverVariant = "hover:bg-accent"
      interactiveAria = externalConnected
        ? "External agent connected. Click to change companion mode and tool access."
        : "External agent attached, not connected. Click to change companion mode and tool access."
    } else if (isOn) {
      leadingVisual = <Sparkles className="h-3 w-3 text-primary" aria-hidden="true" />
      modeLabel = "Companion"
      pillVariant = "border-primary/30 bg-primary/5 text-foreground"
      hoverVariant = "hover:bg-primary/10"
      interactiveAria = "Companion is on. Click to change companion mode and tool access."
    } else {
      leadingVisual = <Moon className="h-3 w-3" aria-hidden="true" />
      modeLabel = "Quiet"
      pillVariant = "border-border bg-secondary text-muted-foreground"
      hoverVariant = "hover:bg-accent hover:text-foreground"
      interactiveAria = "Quiet mode. Click to change companion mode and tool access."
    }

    const pillBase = cn(
      "inline-flex items-center gap-1 rounded-full border py-0.5 text-xs font-semibold",
      iconOnly ? "px-1.5" : "px-2.5"
    )

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
            {leadingVisual}
            {!iconOnly && (
              <>
                <span>{modeLabel}</span>
                <ChevronDown className="h-3 w-3 -mr-0.5 opacity-60" aria-hidden="true" />
              </>
            )}
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

  // Persisted streams only. Archived non-scratchpads offer no stream actions,
  // so their sheet holds just the view rows.
  const offersStreamActions = !(isArchived && !isScratchpad)
  const canOpenSheet = !!stream && !isDraft && (offersStreamActions || sheetViewActions.length > 0)

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
        disabled={renamePending}
      />
    )
  } else if (isThread && stream) {
    headerTitle = <ThreadHeader workspaceId={workspaceId} stream={stream} />
  } else if (isMobile && canOpenSheet) {
    // Mobile: the name is the hero — it takes the full remaining width and IS
    // the sheet trigger. Live state survives as tiny glyphs beside it (lock =
    // encrypted, dot = external agent connection, box = archived); their full
    // affordances live in the sheet. Rename moved into the sheet's action list.
    headerTitle = (
      <StreamTitlePreview name={streamName}>
        <button
          type="button"
          onClick={() => setIsMenuDrawerOpen(true)}
          aria-label={`${streamName} — stream details and actions`}
          aria-haspopup="dialog"
          className="-ml-2 flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors active:bg-accent/50"
        >
          {nameDecrypting && !pendingName ? (
            <Skeleton className="h-5 w-40" />
          ) : (
            <h1 className="min-w-0 truncate font-semibold">{streamName}</h1>
          )}
          {isEncryptedScratchpad && <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
          {isScratchpad && !isEncryptedScratchpad && !!activeBotPresence && (
            <span
              className={cn(
                "inline-block size-2 shrink-0 rounded-full",
                externalConnected ? "bg-emerald-500" : "bg-muted-foreground/40"
              )}
              aria-hidden="true"
            />
          )}
          {isArchived && <ArchiveX className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </StreamTitlePreview>
    )
  } else if (isScratchpad) {
    headerTitle = (
      <StreamTitlePreview name={streamName}>
        <div
          className={cn(
            "group reveal-host inline-flex items-center gap-1 rounded-md px-2 py-1 -ml-2 transition-colors min-w-0",
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
          {canRenameScratchpad && <Pencil className="reveal-actions h-3.5 w-3.5 shrink-0" />}
        </div>
      </StreamTitlePreview>
    )
  } else if (isDm && dmPeerUserId) {
    headerTitle = (
      <StreamTitlePreview name={streamName}>
        <button
          type="button"
          onClick={() => openUserProfile(dmPeerUserId)}
          className="font-semibold truncate hover:underline text-left"
        >
          {streamName}
        </button>
      </StreamTitlePreview>
    )
  } else {
    headerTitle = (
      <StreamTitlePreview name={streamName}>
        <h1 className="font-semibold truncate">{streamName}</h1>
      </StreamTitlePreview>
    )
  }

  const mainStreamContent = (
    <div className="flex h-full flex-col">
      <header className="relative flex h-12 items-center justify-between border-b px-4">
        <div className={cn("flex items-center gap-2 flex-1 min-w-0", isTouchInput && !isEditing && "select-none")}>
          <SidebarToggle location="page" />
          {headerTitle}
          {companionModeIndicator}
          <AgentActivityHeaderChip workspaceId={workspaceId} streamId={streamId} compact={isMobile} />
          {/* Chip strip. The chips are non-shrinking (`shrink-0` leaves), so on a
              phone-width header they would otherwise overflow the flex box and
              paint under the search/panel actions — the strip scrolls instead,
              same recipe as PageHeaderTabs' tab strip. On mobile the chips live
              in the stream sheet; the strip only renders when there is no sheet
              to hold them (drafts, archived non-scratchpads). */}
          {(!isMobile || !canOpenSheet) && (
            <div className="flex items-center gap-2 min-w-0 overflow-x-auto scrollbar-none">
              {stream && !isDraft && (
                <LabelStack
                  workspaceId={workspaceId}
                  resourceType={LabelableResourceTypes.STREAM}
                  resourceId={streamId}
                  className="shrink-0"
                />
              )}
              {isEncryptedScratchpad && !isDraft && (
                <StreamHeaderEncryptionAction workspaceId={workspaceId} encrypted streamId={streamId} />
              )}
              {stream && isScratchpad && !isDraft && (
                <>
                  <InviteActorButton workspaceId={workspaceId!} stream={stream} kind="enclave" />
                  <InviteBotButton workspaceId={workspaceId!} stream={stream} />
                </>
              )}
              {stream && !isThread && !isScratchpad && !isChannel && !isDraft && (
                <Badge variant="secondary" className="shrink-0">
                  {getStreamTypeLabel(stream.type)}
                </Badge>
              )}
              {stream && (isChannel || isThread) && !isDraft && (
                <SharedWithBadge workspaceId={workspaceId} stream={stream} className="shrink-0" />
              )}
              {isArchived && (
                <Badge variant="secondary" className="gap-1 shrink-0">
                  <ArchiveX className="h-3 w-3" />
                  Archived
                </Badge>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 ml-1">
          {stream && !isDraft && (isChannel || isDm) && callsEnabled && (
            // A workspace that has switched calls off shows no calls surface at all.
            <CallStartMenu workspaceId={workspaceId!} streamId={streamId!} startLabel="Start a call" />
          )}
          {stream && !isDraft && <AsideHeaderChip workspaceId={workspaceId!} stream={stream} compact={isMobile} />}
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
          {stream && !isDraft && !isMobile && (
            <Button
              variant="ghost"
              size="icon"
              className={cn("h-8 w-8", isContextOpen && "bg-accent text-accent-foreground")}
              title="In this stream — links, files & memories"
              aria-label="In this stream"
              aria-pressed={isContextOpen}
              onClick={toggleContext}
            >
              <PanelRight className="h-4 w-4" />
            </Button>
          )}
          {(isChannel || isDm) && !isMobile && (
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
          {stream && isMobile && canOpenSheet && (
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
              <StreamSheet
                open={isMenuDrawerOpen}
                onOpenChange={setIsMenuDrawerOpen}
                workspaceId={workspaceId}
                streamId={streamId}
                stream={stream}
                streamName={streamName}
                actions={[
                  ...sheetViewActions,
                  ...(offersStreamActions ? streamMenuActions : []).map((action, i) =>
                    i === 0 && sheetViewActions.length > 0 ? { ...action, separatorBefore: true } : action
                  ),
                ]}
              />
            </>
          )}
          {stream && !isMobile && !isDraft && offersStreamActions && (
            <SidebarActionMenu
              actions={streamMenuActions}
              ariaLabel="Stream actions"
              trigger={
                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Stream actions">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              }
            />
          )}
        </div>
      </header>
      {(isChannel || isDm) && !isDraft && <RejoinBar workspaceId={workspaceId!} streamId={streamId!} />}
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
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && !isConversationViewOpen) setConversationListMounted(false)
        }}
      >
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">Conversations</h2>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setConversationViewOpen(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {conversationListMounted && (
            <ConversationList
              workspaceId={workspaceId!}
              streamId={streamId!}
              onMessageClick={() => setConversationViewOpen(false)}
            />
          )}
        </div>
      </div>
    </>
  )

  // On mobile the panel takes over the full screen, but the timeline stays mounted
  // behind it so closing a thread lands back where the reader was rather than
  // re-running the opening scroll.
  const mobileTakeover = isMobile && isPanelOpen && !panelInAside
  const tabStackShown = isMobile ? mobileTakeover : showContent && !panelInAside
  // A tab floating over the page leaves everything else under it out of reach.
  const floating = tabStackShown && floatingPanelTab(layout, isMobile) !== null

  return (
    <AsideCoversPanesContext.Provider value={asideIsSheet && openAside !== null}>
      <PaneHost
        ref={containerRef}
        columns={isMobile ? "minmax(0,1fr)" : `minmax(0,1fr) ${displayWidth}px ${asideLayout.width}px`}
        animate={shouldAnimate && !isMobile && !asideLayout.isResizing}
        onTransitionEnd={handleTransitionEnd}
      >
        <Pane
          area="1 / 1"
          covered={mobileTakeover}
          inert={floating}
          className={cn(floating && "isolate")}
          ref={mainPaneRef}
          onPointerDownCapture={() => setCurrentPane(null)}
          onFocusCapture={() => setCurrentPane(null)}
        >
          {mainStreamContent}
        </Pane>
        <Pane
          area={isMobile ? "1 / 1" : "1 / 2"}
          // An empty pane over the timeline's cell would still take its taps.
          covered={isMobile && !mobileTakeover}
          data-testid="panel"
          className="bg-background"
        >
          {tabStackShown && (
            <ResizablePanelFrame
              fill={isMobile}
              panelWidth={panelWidth}
              isResizing={isResizing}
              minWidth={minWidth}
              maxWidth={maxWidth}
              onResizeStart={handleResizeStart}
              onResizeMove={handleResizeMove}
              onResizeEnd={handleResizeEnd}
              onResizeKeyDown={handleResizeKeyDown}
              handleInert={floating}
            >
              <PanelTabStack workspaceId={workspaceId} maxColumns={maxColumns} stacked={isMobile} main={mainPaneRef} />
            </ResizablePanelFrame>
          )}
        </Pane>
        {/* The tab stack takes the shortcuts over once it mounts, which trails the panel opening. */}
        {(!isPanelOpen || !(tabStackShown || panelInAside)) && <PaneShortcuts />}
        {asideColumn && (
          <Pane area="1 / 3" inert={floating} className={cn(floating && "isolate")}>
            <AsideColumn workspaceId={workspaceId} aside={asideColumn} layout={asideLayout} />
          </Pane>
        )}
        {asideIsSheet && openAside && (
          <AsideMobileSheet
            workspaceId={workspaceId}
            asideId={openAside.asideId}
            hostStreamId={openAside.hostStreamId}
            originScope={openAside.originScope}
            historyEntry={asideSheetOnly}
          />
        )}
      </PaneHost>
      {/* A `fixed` overlay that would paint over a fullscreen panel, so a takeover
          keeps it out of the tree entirely rather than merely closed. Its
          `?convView` state survives in the URL and returns when the panel closes. */}
      {!mobileTakeover && conversationPanel}
    </AsideCoversPanesContext.Provider>
  )
}
