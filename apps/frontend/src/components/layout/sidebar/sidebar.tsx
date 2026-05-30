import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { FileText, Lock, RefreshCw, StickyNote } from "lucide-react"
import { useLocation, useNavigate, useParams } from "react-router-dom"
import { useAuth } from "@/auth"
import { useCreateEncryptedScratchpad } from "@/hooks/use-create-encrypted-scratchpad"
import {
  useActivityCounts,
  useAllDrafts,
  createDmDraftId,
  useDraftScratchpads,
  useLiveSavedCount,
  useLiveScheduledCount,
  useSidebarConfig,
  useUnreadCounts,
} from "@/hooks"
import { useSyncStatus } from "@/sync/sync-status"
import { useSyncEngine } from "@/sync/sync-engine"
import {
  useWorkspaceUsers,
  useWorkspaceStreams,
  useWorkspaceStreamMemberships,
  useWorkspaceDmPeers,
  useWorkspaceFromStore,
  useWorkspaceUnreadState,
  useWorkspaceLabels,
  useWorkspaceLabelAssignments,
} from "@/stores/workspace-store"
import { useCoordinatedLoading, useSidebar } from "@/contexts"
import { useCreateChannel } from "@/components/create-channel"
import { Button } from "@/components/ui/button"
import { SidebarShell } from "./sidebar-shell"
import { SidebarHeader } from "./sidebar-header"
import { SidebarQuickLinks } from "./quick-links"
import { SidebarStreamList } from "./sidebar-stream-list"
import { HeaderSkeleton, QuickLinksSkeleton, StreamListSkeleton } from "./skeletons"
import { SidebarFooter } from "./sidebar-footer"
import { SidebarEditorDialog } from "./sidebar-editor"
import { resolveSections } from "./resolve-sections"
import type { SidebarActionItem } from "./sidebar-actions"
import { calculateUrgency, categorizeStream } from "./utils"
import type { StreamItemData } from "./types"
import { resolveDmDisplayName } from "@/lib/streams"
import type { CachedLabel } from "@/hooks"
import { StreamTypes, Visibilities, LabelableResourceTypes } from "@threa/types"

interface SidebarProps {
  workspaceId: string
}

export function Sidebar({ workspaceId }: SidebarProps) {
  const { phase } = useCoordinatedLoading()
  const { getSectionState, toggleSectionState, setSidebarHeight, setScrollContainerOffset, collapseOnMobile } =
    useSidebar()
  const { config: sidebarConfig } = useSidebarConfig(workspaceId)
  const [isEditorOpen, setIsEditorOpen] = useState(false)
  const { streamId: activeStreamId, "*": splat } = useParams<{ streamId: string; "*": string }>()
  const location = useLocation()
  const syncStatus = useSyncStatus(`workspace:${workspaceId}`)
  const syncEngine = useSyncEngine()
  const error = syncStatus === "error"
  const workspace = useWorkspaceFromStore(workspaceId)
  const unreadState = useWorkspaceUnreadState(workspaceId)
  const workspaceUsers = useWorkspaceUsers(workspaceId)
  const idbStreams = useWorkspaceStreams(workspaceId)
  const idbStreamMemberships = useWorkspaceStreamMemberships(workspaceId)
  const idbDmPeers = useWorkspaceDmPeers(workspaceId)
  const labels = useWorkspaceLabels(workspaceId)
  const labelAssignments = useWorkspaceLabelAssignments(workspaceId)
  const { createDraft } = useDraftScratchpads(workspaceId)
  const { getUnreadCount } = useUnreadCounts(workspaceId)
  const { getMentionCount, unreadActivityCount } = useActivityCounts(workspaceId)
  const { drafts: allDrafts } = useAllDrafts(workspaceId)
  const { openCreateChannel } = useCreateChannel()
  const { user } = useAuth()
  const navigate = useNavigate()
  const currentUser = workspaceUsers.find((u) => u.workosUserId === user?.id) ?? null
  const createEncryptedScratchpad = useCreateEncryptedScratchpad(workspaceId, currentUser?.id ?? null)

  const draftCount = allDrafts.length
  const savedCount = useLiveSavedCount(workspaceId)
  const scheduledCount = useLiveScheduledCount(workspaceId)
  const isDraftsPage = splat === "drafts" || window.location.pathname.endsWith("/drafts")
  const isSavedPage = splat === "saved" || window.location.pathname.endsWith("/saved")
  const isScheduledPage = splat === "scheduled" || window.location.pathname.includes("/scheduled")
  const isActivityPage = splat === "activity" || window.location.pathname.endsWith("/activity")
  const isMemoryPage = splat === "memory" || location.pathname.endsWith("/memory")
  const isFilesPage = splat === "files" || location.pathname.endsWith("/files")
  const isLabelsPage = splat === "labels" || location.pathname.includes("/labels")

  // Build set of streams the user is a member of (for filtering public channels)
  const memberStreamIds = useMemo(() => {
    const ids = new Set<string>()
    for (const m of idbStreamMemberships) ids.add(m.streamId)
    return ids
  }, [idbStreamMemberships])

  // Build set of muted streams (for suppressing unread badges)
  const mutedStreamIdSet = useMemo(() => new Set(unreadState?.mutedStreamIds ?? []), [unreadState?.mutedStreamIds])
  const dmPeerByStreamId = useMemo(() => new Map(idbDmPeers.map((peer) => [peer.streamId, peer.userId])), [idbDmPeers])

  // Process streams into enriched data with urgency and section
  const processedStreams = useMemo(() => {
    return idbStreams
      .filter((stream) => {
        // Archived streams don't appear in the sidebar
        if (stream.archivedAt) return false
        // Non-public streams always appear (bootstrap only includes them if user has access)
        if (stream.visibility !== Visibilities.PUBLIC) return true
        // Public channels: only show if user is a member
        return memberStreamIds.has(stream.id)
      })
      .map((stream): StreamItemData => {
        const streamWithPreview = { ...stream, lastMessagePreview: stream.lastMessagePreview ?? null }
        const unreadCount = getUnreadCount(stream.id)
        const mentionCount = getMentionCount(stream.id)
        const isMuted = mutedStreamIdSet.has(stream.id)
        const urgency = calculateUrgency(streamWithPreview, unreadCount, mentionCount, isMuted)
        const section = categorizeStream(streamWithPreview, unreadCount, urgency)
        const dmPeerUserId = dmPeerByStreamId.get(stream.id) ?? dmPeerByStreamId.get(stream.rootStreamId ?? "")

        // DM names are viewer-specific and can be stale/null in the cached stream
        // record when socket events overwrite IDB before a bootstrap refetch.
        // Resolve from workspaceUsers via dmPeers so the sidebar stays correct.
        const resolvedDisplayName =
          stream.type === StreamTypes.DM
            ? (resolveDmDisplayName(stream.id, workspaceUsers, idbDmPeers) ?? streamWithPreview.displayName)
            : streamWithPreview.displayName

        return {
          ...streamWithPreview,
          displayName: resolvedDisplayName,
          urgency,
          section,
          dmPeerUserId,
        }
      })
  }, [
    idbStreams,
    memberStreamIds,
    mutedStreamIdSet,
    getUnreadCount,
    getMentionCount,
    dmPeerByStreamId,
    idbDmPeers,
    workspaceUsers,
    unreadState,
  ])

  // System streams are auto-created infrastructure — don't count toward "has content"
  const hasUserStreamsFromStreams = processedStreams.some((s) => s.type !== StreamTypes.SYSTEM)

  // Users without existing DM streams are shown as virtual DM drafts.
  const virtualDmStreams = useMemo(() => {
    if (workspaceUsers.length === 0 || !currentUser) return []

    const dmPeerIds = new Set(idbDmPeers.map((peer) => peer.userId))
    const now = new Date().toISOString()

    return workspaceUsers
      .filter((workspaceUser) => workspaceUser.id !== currentUser.id)
      .filter((workspaceUser) => !dmPeerIds.has(workspaceUser.id))
      .map(
        (workspaceUser): StreamItemData => ({
          id: createDmDraftId(workspaceUser.id),
          workspaceId,
          type: StreamTypes.DM,
          displayName: workspaceUser.name,
          slug: null,
          description: null,
          visibility: Visibilities.PRIVATE,
          parentStreamId: null,
          parentMessageId: null,
          rootStreamId: null,
          companionMode: "off",
          companionPersonaId: null,
          createdBy: currentUser.id,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          lastMessagePreview: null,
          urgency: "quiet",
          section: "other",
          dmPeerUserId: workspaceUser.id,
        })
      )
      .sort((a, b) => (a.displayName ?? "").localeCompare(b.displayName ?? ""))
  }, [workspaceUsers, idbDmPeers, currentUser, workspaceId])

  const hasUserStreams = hasUserStreamsFromStreams || virtualDmStreams.length > 0

  // Active labels by id — resolves the chip header for label sections.
  const labelsById = useMemo(() => {
    const map = new Map<string, CachedLabel>()
    for (const label of labels) if (!label.archivedAt) map.set(label.id, label)
    return map
  }, [labels])

  // labelId → set of stream ids the viewer can see carrying that label.
  const streamIdsByLabel = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const assignment of labelAssignments) {
      if (assignment.resourceType !== LabelableResourceTypes.STREAM) continue
      const set = map.get(assignment.labelId) ?? new Set<string>()
      set.add(assignment.resourceId)
      map.set(assignment.labelId, set)
    }
    return map
  }, [labelAssignments])

  // Resolve the persisted sidebar config into ordered, sorted, capped lists.
  const resolvedSections = useMemo(
    () => resolveSections(sidebarConfig, { processedStreams, virtualDmStreams, getUnreadCount, streamIdsByLabel }),
    [sidebarConfig, processedStreams, virtualDmStreams, getUnreadCount, streamIdsByLabel]
  )

  // The Quick Links block renders only when the user keeps it in their layout —
  // removing the section from the editor takes it out of both the normal list
  // (resolved as a positioned section) and the empty-streams state.
  const hasQuickLinksSection = sidebarConfig.sections.some((s) => s.spec.kind === "quicklinks")

  // Track sidebar and scroll container dimensions for position calculations
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = scrollContainerRef.current
    const sidebar = sidebarRef.current
    if (!container || !sidebar) return

    const updateDimensions = () => {
      // Get sidebar total height
      setSidebarHeight(sidebar.offsetHeight)

      // Calculate scroll container offset from sidebar top
      // This accounts for header + quick links sections
      const containerRect = container.getBoundingClientRect()
      const sidebarRect = sidebar.getBoundingClientRect()
      setScrollContainerOffset(containerRect.top - sidebarRect.top)
    }

    // Initial measurement
    updateDimensions()

    // Observe size changes on both elements
    const observer = new ResizeObserver(updateDimensions)
    observer.observe(container)
    observer.observe(sidebar)

    return () => observer.disconnect()
  }, [setSidebarHeight, setScrollContainerOffset])

  // During initial coordinated loading, show skeleton
  if (phase !== "ready") {
    return (
      <SidebarShell
        header={<HeaderSkeleton />}
        body={
          <>
            <QuickLinksSkeleton />
            <StreamListSkeleton />
          </>
        }
      />
    )
  }

  // Show error state with retry button
  if (error && idbStreams.length === 0) {
    return (
      <SidebarShell
        header={<HeaderSkeleton />}
        body={
          <div className="flex flex-col items-center justify-center h-full p-4 text-center">
            <p className="text-sm text-muted-foreground mb-3">Failed to load workspace</p>
            <Button variant="outline" size="sm" onClick={() => syncEngine.retryWorkspace()} className="gap-2">
              <RefreshCw className="h-4 w-4" />
              Retry
            </Button>
          </div>
        }
      />
    )
  }

  const handleCreateScratchpad = async () => {
    try {
      const draftId = await createDraft("on")
      collapseOnMobile()
      navigate(`/w/${workspaceId}/s/${draftId}`)
    } catch {
      toast.error("Failed to create scratchpad")
    }
  }

  const handleCreateQuickNote = async () => {
    const draftId = await createDraft("off")
    collapseOnMobile()
    navigate(`/w/${workspaceId}/s/${draftId}`)
  }

  // `runSidebarAction` toasts on throw, so let the encrypted creator's session
  // checks propagate ("Unlock encrypted scratchpads first…") rather than
  // swallowing them here.
  const handleCreateEncryptedScratchpad = async () => {
    const streamId = await createEncryptedScratchpad()
    collapseOnMobile()
    navigate(`/w/${workspaceId}/s/${streamId}`)
  }

  const scratchpadAddMenuActions: SidebarActionItem[] = [
    {
      id: "new-scratchpad",
      label: "New Scratchpad",
      icon: FileText,
      onSelect: handleCreateScratchpad,
    },
    {
      id: "new-quick-note",
      label: "New Quick Note",
      icon: StickyNote,
      onSelect: handleCreateQuickNote,
    },
    {
      id: "new-encrypted-scratchpad",
      label: "New Encrypted Scratchpad",
      icon: Lock,
      onSelect: handleCreateEncryptedScratchpad,
      separatorBefore: true,
    },
  ]

  const handleCreateChannel = () => {
    collapseOnMobile()
    openCreateChannel()
  }

  return (
    <>
      <SidebarShell
        sidebarRef={sidebarRef}
        scrollContainerRef={scrollContainerRef}
        header={
          <SidebarHeader
            workspaceName={workspace?.name ?? ""}
            onEditLayout={() => setIsEditorOpen(true)}
            hideViewToggle={!hasUserStreams}
          />
        }
        body={
          <SidebarStreamList
            workspaceId={workspaceId}
            hasError={Boolean(error)}
            hasUserStreams={hasUserStreams}
            activeStreamId={activeStreamId}
            processedStreams={processedStreams}
            resolvedSections={resolvedSections}
            labelsById={labelsById}
            getUnreadCount={getUnreadCount}
            getMentionCount={getMentionCount}
            getSectionState={getSectionState}
            toggleSectionState={toggleSectionState}
            onCreateScratchpad={handleCreateScratchpad}
            onCreateChannel={handleCreateChannel}
            scratchpadAddMenuActions={scratchpadAddMenuActions}
            quickLinksSlot={
              hasQuickLinksSection ? (
                <SidebarQuickLinks
                  workspaceId={workspaceId}
                  quickLinks={sidebarConfig.quickLinks}
                  isDraftsPage={isDraftsPage}
                  draftCount={draftCount}
                  isSavedPage={isSavedPage}
                  savedCount={savedCount}
                  isScheduledPage={isScheduledPage}
                  scheduledCount={scheduledCount}
                  isActivityPage={isActivityPage}
                  isMemoryPage={isMemoryPage}
                  isFilesPage={isFilesPage}
                  isLabelsPage={isLabelsPage}
                  unreadActivityCount={unreadActivityCount}
                />
              ) : undefined
            }
            scrollContainerRef={scrollContainerRef}
          />
        }
        footer={
          <SidebarFooter
            workspaceId={workspaceId}
            currentUser={currentUser}
            onCreateScratchpad={handleCreateScratchpad}
            onCreateChannel={handleCreateChannel}
            scratchpadAddMenuActions={scratchpadAddMenuActions}
          />
        }
      />
      <SidebarEditorDialog workspaceId={workspaceId} open={isEditorOpen} onOpenChange={setIsEditorOpen} />
    </>
  )
}
