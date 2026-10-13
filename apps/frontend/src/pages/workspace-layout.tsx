import {
  useState,
  useEffect,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react"
import { Outlet, useParams, useSearchParams, useMatch, useNavigate, Navigate } from "react-router-dom"
import { AppShell } from "@/components/layout/app-shell"
import { Sidebar } from "@/components/layout/sidebar"
import { AppToastHost } from "@/components/app-update-toast"
import { MentionableMarkdownWrapper } from "@/components/ui/markdown-content"
import type { MentionType } from "@/lib/markdown/mention-context"
import { UserProfileProvider, useUserProfile } from "@/components/user-profile"
import { WorkspaceEmojiProvider } from "@/components/workspace-emoji"
import { WorkspaceCommandListProvider } from "@/components/workspace-command-list"
import { ChannelLinkProvider } from "@/lib/markdown/channel-link-context"
import {
  SocketProvider,
  useSocket,
  useSocketReconnectCount,
  useSocketStatus,
  useWorkspaceService,
  useStreamService,
  useMessageService,
  useScheduledService,
  PanelProvider,
  QuickSwitcherProvider,
  PreferencesProvider,
  SettingsProvider,
  useSettings,
  CoordinatedLoadingProvider,
  CoordinatedLoadingGate,
  MainContentGate,
  SidebarProvider,
  useSidebar,
  TraceProvider,
  useTrace,
  MediaGalleryProvider,
  CodeViewerProvider,
  useCurrentPane,
  isDraftPanel,
  isConversationPanel,
  parseConversationPanel,
  parseComposePanel,
} from "@/contexts"
import {
  useKeyboardShortcuts,
  useMentionables,
  usePersistLastLocation,
  useNavigationJournal,
  useRecordNavigationJournal,
  useRebuildLaunchAncestors,
  type JournalStep,
  useAppUpdate,
  useMessageQueue,
  useUnreadTabIndicator,
  useNotificationSweep,
  useVisibleStreams,
  useBackgroundBootstrapSync,
} from "@/hooks"
import { useDecryptStreamNames } from "@/hooks/use-decrypt-stream-names"
import { usePageResume } from "@/hooks/use-page-resume"
import { setLastWorkspaceId } from "@/lib/last-workspace"
import { useCapturePageviews } from "@/lib/analytics/use-capture-pageviews"
import { isServerStreamId } from "@/lib/stream-ids"
import { useAccountScope, useAuth } from "@/auth"
import { useWorkspaceStreamsSelect, type CachedStream } from "@/stores/workspace-store"
import { isLinkableStreamType } from "@/lib/streams"
import { SyncEngine, SyncEngineContext } from "@/sync/sync-engine"
import { ReadCommitQueue, ReadCommitQueueContext } from "@/sync/read-commit-queue"
import { useUnreadCounts } from "@/hooks/use-unread-counts"
import { useOpenAside } from "@/hooks/use-open-aside"
import { draftsApi, messagesApi, syncApi } from "@/api"
import { QuickSwitcher, type QuickSwitcherMode } from "@/components/quick-switcher"
import { ComposeOverlayMount } from "@/components/board/compose-overlay-mount"
import { SettingsDialog } from "@/components/settings"
import { WorkspaceSettingsDialog } from "@/components/workspace-settings/workspace-settings-dialog"
import { AccountSwitcherDialog, LogoutScopeDialog } from "@/components/account-switcher"
import { StreamSettingsDialog } from "@/components/stream-settings/stream-settings-dialog"
import { CreateChannelDialog } from "@/components/create-channel"
import { AttachmentExplorer, useExplorerUrlState } from "@/components/attachment-explorer"
import { AgentOutcomesExplorer, useOutcomesUrlState } from "@/components/agent-outcomes"
import { SearchPanelProvider, useSearchPanel } from "@/components/search"
import { ComposeSlotsProvider } from "@/components/panes"
import { E2eUnlockProvider } from "@/components/encryption/e2e-unlock-provider"
import { CallDock, CallLaunchProvider, IncomingCallOverlay } from "@/components/call"
import { RewrapNudgeListener } from "@/components/encryption/rewrap-nudge-listener"
import { TraceDialog } from "@/components/trace"
import { useQueryClient } from "@tanstack/react-query"
import { SyncStatusStore, SyncStatusContext } from "@/sync/sync-status"
import { copyStreamLink, copyConversationLink } from "@/lib/stream-links"
import { PerfCaptureProvider } from "@/lib/perf/context"
import { PerfCaptureConsentGate } from "@/lib/perf/consent"
import { AnalyticsConsentGate } from "@/lib/analytics/gate"
import { AnalyticsConsentBanner } from "@/components/analytics-consent-banner"
import { useResolveOrBounce } from "./use-resolve-or-bounce"
import { useNotificationAccountSwitch } from "./use-notification-account-switch"
import { useNotificationActionFailure } from "./use-notification-action-failure"
import { PANEL_PARAM, panelIdsOf, parsePanelLayout } from "@/lib/panel-tabs"

/**
 * How long the tab must be backgrounded before a resume triggers the engine's
 * socket probe + catch-up. A few seconds away is enough for socket events to
 * be missed (a notification-shade peek that delivered a push, a quick app
 * switch), and the resume path is cheap in active mode (cursor catch-up +
 * per-stream deltas).
 */
const PAGE_RESUME_THRESHOLD_MS = 5_000

interface WorkspaceKeyboardHandlerProps {
  onOpenSwitcher: (mode: QuickSwitcherMode) => void
  currentStreamId: string | undefined
  workspaceId: string
  children: ReactNode
}

function WorkspaceKeyboardHandler({
  onOpenSwitcher,
  currentStreamId,
  workspaceId,
  children,
}: WorkspaceKeyboardHandlerProps) {
  const { openSettings } = useSettings()
  const { open: openExplorer } = useExplorerUrlState()
  const { open: openOutcomes } = useOutcomesUrlState()
  const journal = useNavigationJournal(workspaceId)
  const navigate = useNavigate()
  const stepJournal = (target: JournalStep | null) => {
    if (!target) return
    journal.step(target)
    navigate(target.to, { state: target.state })
  }

  useKeyboardShortcuts({
    openQuickSwitcher: () => onOpenSwitcher("stream"),
    openCommands: () => onOpenSwitcher("command"),
    openSettings: () => openSettings(),
    openAttachmentExplorer: () =>
      openExplorer({
        streamIds: currentStreamId ? [currentStreamId] : [],
      }),
    openAgentAgenda: () =>
      openOutcomes({
        streamIds: currentStreamId ? [currentStreamId] : [],
      }),
    historyBack: () => stepJournal(journal.back),
    historyForward: () => stepJournal(journal.forward),
  })

  return <>{children}</>
}

function useOnlineStatus(): boolean {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener("online", listener)
      window.addEventListener("offline", listener)
      return () => {
        window.removeEventListener("online", listener)
        window.removeEventListener("offline", listener)
      }
    },
    () => navigator.onLine,
    () => true
  )
}

/**
 * Registers the "copy link" shortcut. Must be rendered inside PanelProvider so
 * it can read the current pane. When it is a panel: a conversation panel copies
 * the conversation link, a real (non-draft) thread copies the thread link;
 * otherwise it falls through to the main stream link.
 */
function StreamLinkKeyboardHandler({
  workspaceId,
  mainStreamId,
}: {
  workspaceId: string
  mainStreamId: string | undefined
}) {
  const panelId = useCurrentPane()

  useKeyboardShortcuts({
    copyStreamLink: () => {
      if (panelId) {
        if (isConversationPanel(panelId)) {
          const conversationId = parseConversationPanel(panelId)
          if (conversationId) {
            void copyConversationLink(workspaceId, conversationId)
            return
          }
          // Malformed `conv:` id (hand-edited/stale URL) — fall through to the main link.
        } else if (!isDraftPanel(panelId)) {
          void copyStreamLink(workspaceId, parseComposePanel(panelId) ?? panelId)
          return
        }
      }
      if (mainStreamId) void copyStreamLink(workspaceId, mainStreamId)
    },
  })

  return null
}

/**
 * Registers sidebar-related keyboard shortcuts. Must be rendered inside
 * SidebarProvider so it can access the sidebar context.
 */
function SidebarKeyboardHandler() {
  const { togglePinned } = useSidebar()

  useKeyboardShortcuts({
    toggleSidebar: togglePinned,
  })

  return null
}

/**
 * Registers the workspace search shortcut. Must be rendered inside
 * SearchPanelProvider (and thus SidebarProvider) — search opens as a sidebar
 * mode on desktop and as a full page on mobile.
 */
function SearchKeyboardHandler() {
  const { openSearch } = useSearchPanel()

  useKeyboardShortcuts({
    openSearch: () => openSearch(),
  })

  return null
}

/**
 * Constructs a SyncEngine per workspace and wires it to socket lifecycle.
 * The engine owns bootstrap, reconnection, and all workspace-level socket
 * event handlers.
 */
export function WorkspaceSyncHandler({
  workspaceId,
  visibleStreamIds,
  children,
}: {
  workspaceId: string
  visibleStreamIds: string[]
  children: ReactNode
}) {
  const socket = useSocket()
  const socketStatus = useSocketStatus()
  const reconnectCount = useSocketReconnectCount()
  const queryClient = useQueryClient()
  const workspaceService = useWorkspaceService()
  const streamService = useStreamService()
  const messageService = useMessageService()
  const scheduledService = useScheduledService()
  const syncStatusStore = useContext(SyncStatusContext)
  const { user } = useAuth()
  const { activeWorkosUserId } = useAccountScope()
  const isOnline = useOnlineStatus()
  const { streamId: currentStreamId } = useParams<{ streamId: string }>()
  const wasOfflineRef = useRef(!navigator.onLine)
  // One SyncEngine per mount (the layout remounts per workspace); rebuilt only
  // after it destroys itself on an account switch.
  const syncEngineRef = useRef<SyncEngine | null>(null)
  let syncEngine = syncEngineRef.current
  if (!syncEngine || syncEngine.isDestroyed) {
    syncEngine = new SyncEngine({
      workspaceId,
      syncStatus: syncStatusStore!,
      queryClient,
      // Bound to the account this subtree was mounted for, so the service
      // worker can only answer a bootstrap from a copy pre-fetched for the same
      // viewer. A switch remounts the subtree, which rebuilds the binding.
      workspaceService: {
        bootstrap: (id, opts) => workspaceService.bootstrap(id, { ...opts, accountId: activeWorkosUserId }),
      },
      streamService,
      messageService,
      reactionService: {
        add: (wid: string, mid: string, emoji: string) => messagesApi.addReaction(wid, mid, emoji),
        remove: (wid: string, mid: string, emoji: string) => messagesApi.removeReaction(wid, mid, emoji),
      },
      scheduledService: {
        create: scheduledService.create,
        delete: scheduledService.delete,
        sendNow: scheduledService.sendNow,
      },
      draftsService: {
        list: (wid: string) => draftsApi.list(wid),
        upsert: draftsApi.upsert,
        resolve: draftsApi.resolve,
        delete: draftsApi.delete,
      },
      syncService: syncApi,
    })
    syncEngineRef.current = syncEngine
  }

  // Keep syncEngine refs in sync with React state
  useEffect(() => {
    syncEngine.setCurrentStreamId(currentStreamId)
  }, [syncEngine, currentStreamId])

  useEffect(() => {
    syncEngine.setVisibleStreamIds(visibleStreamIds)
  }, [syncEngine, visibleStreamIds])

  useEffect(() => {
    syncEngine.setCurrentUser(user)
  }, [syncEngine, user])

  // Wire SyncEngine to socket connect/disconnect/reconnect based on actual socket status.
  useEffect(() => {
    if (!socket || socketStatus !== "connected") {
      syncEngine.onDisconnect()
      return
    }

    void syncEngine.onConnect(socket)
  }, [socket, socketStatus, syncEngine, reconnectCount])

  useEffect(() => {
    if (!socket) {
      wasOfflineRef.current = !isOnline
      return
    }

    if (!isOnline) {
      wasOfflineRef.current = true
      syncEngine.onDisconnect()
      return
    }

    const wasOffline = wasOfflineRef.current
    wasOfflineRef.current = false

    if (wasOffline) {
      void syncEngine.refreshAfterConnectivityResume()
    }
  }, [isOnline, socket, syncEngine])

  // Re-read visible event windows after every real away/back cycle: Android can
  // freeze the PWA and let the service worker write a pushed message even during
  // a sub-5s app switch. Socket probing and network catch-up keep the threshold
  // because those are unnecessary for momentary focus loss.
  usePageResume((awayDurationMs) => {
    if (awayDurationMs < PAGE_RESUME_THRESHOLD_MS) {
      void syncEngine.refreshVisibleEventReads()
      return
    }
    void syncEngine.handlePageResume()
  }, 0)

  // StrictMode runs cleanup then setup synchronously and would hand the socket
  // connect effect a destroyed engine, so destroy waits a microtask and only
  // runs if no setup followed — i.e. a real unmount.
  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      queueMicrotask(() => {
        if (!mountedRef.current) syncEngineRef.current?.destroy()
      })
    }
  }, [])

  // A push for a parked account stashes its recipient id (notification-intent);
  // flip the active account in place before this deep link bootstraps wrong.
  useNotificationAccountSwitch(workspaceId)
  useNotificationActionFailure()

  // Terminal workspace error (404/403): a different signed-in account may own
  // this deep link — resolve→flip in place, else bounce to the list.
  useResolveOrBounce(workspaceId, syncEngine)

  // The outbound read-commit pipeline, one owner per mount (same ref-based
  // lifecycle as the SyncEngine above).
  const { markAsRead } = useUnreadCounts(workspaceId)
  const readCommitQueueRef = useRef<ReadCommitQueue | null>(null)
  let readCommitQueue = readCommitQueueRef.current
  if (!readCommitQueue || readCommitQueue.isDisposed) {
    readCommitQueue = new ReadCommitQueue({ commitRef: { current: markAsRead } })
    readCommitQueueRef.current = readCommitQueue
  }
  readCommitQueue.commitRef.current = markAsRead
  // Unlike the SyncEngine's deferred destroy, the queue disposes synchronously
  // on unmount: the recreate check above rebuilds a disposed queue on the next
  // render. Without this, the pagehide listener held the queue alive after
  // leaving the workspace layout.
  useEffect(() => {
    return () => {
      readCommitQueueRef.current?.dispose()
    }
  }, [])

  return (
    <SyncEngineContext.Provider value={syncEngine}>
      <ReadCommitQueueContext.Provider value={readCommitQueue}>{children}</ReadCommitQueueContext.Provider>
    </SyncEngineContext.Provider>
  )
}

function MessageQueueHandler({ workspaceId }: { workspaceId: string }) {
  useMessageQueue(workspaceId)
  return null
}

function StreamNameDecryptor({ workspaceId }: { workspaceId: string }) {
  useDecryptStreamNames(workspaceId)
  return null
}

function UnreadTabIndicator({ workspaceId }: { workspaceId: string }) {
  useUnreadTabIndicator(workspaceId)
  return null
}

function NotificationSweeper({ workspaceId }: { workspaceId: string }) {
  useNotificationSweep(workspaceId)
  return null
}

/**
 * Publishes the main stream for push suppression. Panel panes register their
 * own streams while they show: a covered or folded tab is in the URL but not
 * on screen, and its pushes must still arrive.
 */
function VisibleStreamPresence({ workspaceId, streamIds }: { workspaceId: string; streamIds: string[] }) {
  useVisibleStreams(workspaceId, streamIds.filter(isServerStreamId))
  return null
}

/**
 * Wires the socket's reconnect signal into the app-lifetime update controller.
 * The update notifier itself lives at the app root so its per-build dedup is
 * mount-once; this checker only triggers a check on reconnect.
 */
function AppUpdateChecker() {
  const reconnectCount = useSocketReconnectCount()
  const { check } = useAppUpdate()
  const checkRef = useRef(check)
  checkRef.current = check

  useEffect(() => {
    if (reconnectCount === 0) return
    void checkRef.current()
  }, [reconnectCount])

  return null
}

function FreshnessWatchers() {
  useBackgroundBootstrapSync()
  return null
}

/** Each of these reads the stream list, so they live in a leaf, never on the layout that renders every provider. */
function LocationRecorders({ workspaceId }: { workspaceId: string }) {
  usePersistLastLocation(workspaceId)
  useRecordNavigationJournal(workspaceId)
  useRebuildLaunchAncestors(workspaceId)
  return null
}

function TraceDialogContainer() {
  const { isOpen } = useTrace()

  if (!isOpen) {
    return null
  }

  return <TraceDialog />
}

/**
 * Bridges UserProfileProvider with MentionableMarkdownWrapper (INV-18: standalone component).
 * Reads the mentionables itself: the layout renders every provider inline, so a
 * data subscription there re-renders the whole provider tree on each write.
 */
function MentionableWrapper({ children }: { children: ReactNode }) {
  const { mentionables } = useMentionables()
  const { openUserProfile } = useUserProfile()

  const handleMentionClick = useCallback(
    (slug: string, type: MentionType, id?: string) => {
      if (type !== "user" && type !== "me") return
      // Pointer-link mentions carry the resolved id (INV-64) — use it directly
      // rather than re-resolving a (mutable) slug. Bare-slug mentions fall back.
      if (id) {
        openUserProfile(id)
        return
      }
      const mentionable = mentionables.find((m) => m.slug === slug)
      if (mentionable) openUserProfile(mentionable.id)
    },
    [mentionables, openUserProfile]
  )

  return (
    <MentionableMarkdownWrapper mentionables={mentionables} onMentionClick={handleMentionClick}>
      {children}
    </MentionableMarkdownWrapper>
  )
}

function pickLinkTargets(streams: CachedStream[]) {
  return streams
    .filter((stream) => isLinkableStreamType(stream.type))
    .map(({ id, type, slug, displayName }) => ({ id, type, slug, displayName }))
}

/** Owns the stream-list subscription for channel links, for the same reason. */
function WorkspaceChannelLinkProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const streams = useWorkspaceStreamsSelect(workspaceId, pickLinkTargets)
  return (
    <ChannelLinkProvider workspaceId={workspaceId} streams={streams}>
      {children}
    </ChannelLinkProvider>
  )
}

/**
 * The palette with the aside opener bound. The opener creates a stream, so it
 * needs the services and sync providers the layout mounts below — hence a
 * sibling of the palette inside them, not a hook on the layout itself.
 */
function WorkspaceQuickSwitcher(props: Omit<ComponentProps<typeof QuickSwitcher>, "openAside">) {
  const openAside = useOpenAside(props.workspaceId)
  const openAsideOnStream = useCallback(
    (streamId: string) => openAside({ kind: "stream", hostStreamId: streamId }),
    [openAside]
  )
  return <QuickSwitcher {...props} openAside={openAsideOnStream} />
}

export function WorkspaceLayout() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  // Connect copies share ids across workspaces: no state mounted for one workspace survives into another.
  return <WorkspaceLayoutContent key={workspaceId} />
}

function WorkspaceLayoutContent() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const [searchParams] = useSearchParams()
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [switcherMode, setSwitcherMode] = useState<QuickSwitcherMode>("stream")
  const { user, loading: authLoading } = useAuth()

  // Extract streamId from nested route (if on /s/:streamId)
  const streamMatch = useMatch("/w/:workspaceId/s/:streamId")
  const streamId = streamMatch?.params.streamId

  // Collect all stream IDs: main stream + any open panels
  const panelValue = searchParams.get(PANEL_PARAM)
  const streamIds = useMemo(
    () => [streamId, ...panelIdsOf(parsePanelLayout(panelValue))].filter((id): id is string => Boolean(id)),
    [streamId, panelValue]
  )
  // The first reveal waits for each section's tab on show; background tabs stay
  // synced without holding it. Sections folded away at this width still count:
  // that costs a slower reveal, never an early one.
  const onScreenStreamIds = useMemo(
    () =>
      [
        streamId,
        ...parsePanelLayout(panelValue).columns.flatMap((column) => column.map(({ active }) => active)),
      ].filter((id): id is string => Boolean(id)),
    [streamId, panelValue]
  )
  const mainStreamIds = useMemo(() => (streamId ? [streamId] : []), [streamId])
  // A `conv:<id>` panel is not a stream: fetching its bootstrap 404s and joining
  // its room is rejected, and both delayed the coordinated reveal on every cold
  // open with a conversation panel in the URL. Same rule the SyncEngine and the
  // presence registration above already apply (INV-35).
  const coordinatedStreamIds = useMemo(() => onScreenStreamIds.filter(isServerStreamId), [onScreenStreamIds])

  useCapturePageviews()

  // Remember the workspace the user is in so the `/` entry route can redirect
  // straight here on a returning launch (renders from IndexedDB) instead of
  // routing through the control-plane workspace list. Only once auth resolved
  // to a real user so a pre-auth render can't pin a workspace.
  useEffect(() => {
    if (workspaceId && user) {
      setLastWorkspaceId(user.id, workspaceId)
    }
  }, [workspaceId, user])

  const openSwitcher = useCallback((mode: QuickSwitcherMode) => {
    setSwitcherMode(mode)
    setSwitcherOpen(true)
  }, [])

  // Single SyncStatusStore instance per workspace — tracks sync state for all resources.
  const syncStatusStore = useMemo(() => new SyncStatusStore(), [workspaceId])

  if (!workspaceId) {
    return null
  }

  if (authLoading) {
    return null
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  return (
    <SyncStatusContext.Provider value={syncStatusStore}>
      <PerfCaptureProvider>
        <SocketProvider workspaceId={workspaceId}>
          <WorkspaceSyncHandler workspaceId={workspaceId} visibleStreamIds={streamIds}>
            <UnreadTabIndicator workspaceId={workspaceId} />
            <NotificationSweeper workspaceId={workspaceId} />
            <VisibleStreamPresence workspaceId={workspaceId} streamIds={mainStreamIds} />
            <AppUpdateChecker />
            <FreshnessWatchers />
            <MessageQueueHandler workspaceId={workspaceId} />
            <StreamNameDecryptor workspaceId={workspaceId} />
            <CoordinatedLoadingProvider workspaceId={workspaceId} streamIds={coordinatedStreamIds}>
              <WorkspaceChannelLinkProvider workspaceId={workspaceId}>
                <CallLaunchProvider>
                  <PreferencesProvider workspaceId={workspaceId}>
                    <UserProfileProvider>
                      <MentionableWrapper>
                        <WorkspaceCommandListProvider workspaceId={workspaceId}>
                          <WorkspaceEmojiProvider workspaceId={workspaceId}>
                            <SettingsProvider>
                              <WorkspaceKeyboardHandler
                                onOpenSwitcher={openSwitcher}
                                currentStreamId={streamId}
                                workspaceId={workspaceId}
                              >
                                <E2eUnlockProvider workspaceId={workspaceId}>
                                  <QuickSwitcherProvider openSwitcher={openSwitcher}>
                                    <PanelProvider>
                                      <ComposeSlotsProvider>
                                        <PerfCaptureConsentGate workspaceId={workspaceId} />
                                        <AnalyticsConsentGate workspaceId={workspaceId} />
                                        <AnalyticsConsentBanner workspaceId={workspaceId} />
                                        <StreamLinkKeyboardHandler workspaceId={workspaceId} mainStreamId={streamId} />
                                        <RewrapNudgeListener workspaceId={workspaceId} />
                                        <MediaGalleryProvider>
                                          <CodeViewerProvider>
                                            <TraceProvider>
                                              <SidebarProvider>
                                                <SearchPanelProvider workspaceId={workspaceId}>
                                                  <SidebarKeyboardHandler />
                                                  <SearchKeyboardHandler />
                                                  <CoordinatedLoadingGate>
                                                    <AppShell sidebar={<Sidebar workspaceId={workspaceId} />}>
                                                      <MainContentGate>
                                                        <Outlet />
                                                      </MainContentGate>
                                                    </AppShell>
                                                  </CoordinatedLoadingGate>
                                                  <WorkspaceQuickSwitcher
                                                    workspaceId={workspaceId}
                                                    open={switcherOpen}
                                                    onOpenChange={setSwitcherOpen}
                                                    initialMode={switcherMode}
                                                    currentStreamId={streamId}
                                                  />
                                                  <ComposeOverlayMount workspaceId={workspaceId} />
                                                </SearchPanelProvider>
                                              </SidebarProvider>
                                              <SettingsDialog />
                                              <WorkspaceSettingsDialog workspaceId={workspaceId} />
                                              <AccountSwitcherDialog />
                                              <LogoutScopeDialog />
                                              <StreamSettingsDialog workspaceId={workspaceId} />
                                              <CreateChannelDialog workspaceId={workspaceId} />
                                              <AttachmentExplorer workspaceId={workspaceId} />
                                              <AgentOutcomesExplorer workspaceId={workspaceId} />
                                              <TraceDialogContainer />
                                              <AppToastHost />
                                            </TraceProvider>
                                          </CodeViewerProvider>
                                        </MediaGalleryProvider>
                                      </ComposeSlotsProvider>
                                    </PanelProvider>
                                  </QuickSwitcherProvider>
                                </E2eUnlockProvider>
                              </WorkspaceKeyboardHandler>
                            </SettingsProvider>
                          </WorkspaceEmojiProvider>
                        </WorkspaceCommandListProvider>
                      </MentionableWrapper>
                    </UserProfileProvider>
                  </PreferencesProvider>
                  <CallDock />
                  <IncomingCallOverlay workspaceId={workspaceId} />
                </CallLaunchProvider>
              </WorkspaceChannelLinkProvider>
            </CoordinatedLoadingProvider>
          </WorkspaceSyncHandler>
        </SocketProvider>
        <LocationRecorders workspaceId={workspaceId} />
      </PerfCaptureProvider>
    </SyncStatusContext.Provider>
  )
}
