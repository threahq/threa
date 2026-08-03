import {
  useState,
  useEffect,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { Outlet, useParams, useSearchParams, useMatch, Navigate } from "react-router-dom"
import { AppShell } from "@/components/layout/app-shell"
import { Sidebar } from "@/components/layout/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { MentionableMarkdownWrapper, type MentionableMarkdownWrapperProps } from "@/components/ui/markdown-content"
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
  usePanel,
  isDraftPanel,
  isConversationPanel,
  parseConversationPanel,
} from "@/contexts"
import {
  useKeyboardShortcuts,
  useMentionables,
  usePersistLastLocation,
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
import { isServerStreamId } from "@/lib/stream-ids"
import { useAuth } from "@/auth"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { setWorkspaceReadMode } from "@/stores/workspace-table-registry"
import { useFeatureFlag } from "@/hooks/use-feature-flags"
import { SyncEngine, SyncEngineContext, isSyncEngineCurrent } from "@/sync/sync-engine"
import { draftsApi, messagesApi, syncApi } from "@/api"
import { QuickSwitcher, type QuickSwitcherMode } from "@/components/quick-switcher"
import { ComposeOverlayMount } from "@/components/board/compose-overlay-mount"
import { SettingsDialog } from "@/components/settings"
import { WorkspaceSettingsDialog } from "@/components/workspace-settings/workspace-settings-dialog"
import { AccountSwitcherDialog, LogoutScopeDialog } from "@/components/account-switcher"
import { StreamSettingsDialog } from "@/components/stream-settings/stream-settings-dialog"
import { CreateChannelDialog } from "@/components/create-channel"
import { AttachmentExplorer, useExplorerUrlState } from "@/components/attachment-explorer"
import { SearchPanelProvider, useSearchPanel } from "@/components/search"
import { E2eUnlockProvider } from "@/components/encryption/e2e-unlock-provider"
import { CallDock, CallLaunchProvider, IncomingCallOverlay } from "@/components/call"
import { EnclaveRewrapNudgeListener } from "@/components/encryption/enclave-rewrap-nudge-listener"
import { TraceDialog } from "@/components/trace"
import { useQueryClient } from "@tanstack/react-query"
import { SyncStatusStore, SyncStatusContext } from "@/sync/sync-status"
import { copyStreamLink, copyConversationLink } from "@/lib/stream-links"
import { PerfCaptureProvider } from "@/lib/perf/context"
import { PerfCaptureConsentGate } from "@/lib/perf/consent"
import { useResolveOrBounce } from "./use-resolve-or-bounce"
import { useNotificationAccountSwitch } from "./use-notification-account-switch"

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
  children: ReactNode
}

function WorkspaceKeyboardHandler({ onOpenSwitcher, currentStreamId, children }: WorkspaceKeyboardHandlerProps) {
  const { openSettings } = useSettings()
  const { open: openExplorer } = useExplorerUrlState()

  useKeyboardShortcuts({
    openQuickSwitcher: () => onOpenSwitcher("stream"),
    openCommands: () => onOpenSwitcher("command"),
    openSettings: () => openSettings(),
    openAttachmentExplorer: () =>
      openExplorer({
        streamIds: currentStreamId ? [currentStreamId] : [],
      }),
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
 * it can read which pane (main view vs thread panel) the user last interacted
 * with. When the panel is focused: a conversation panel copies the conversation
 * link, a real (non-draft) thread copies the thread link; otherwise it falls
 * through to the main stream link.
 */
function StreamLinkKeyboardHandler({
  workspaceId,
  mainStreamId,
}: {
  workspaceId: string
  mainStreamId: string | undefined
}) {
  const { panelId, getFocusedPane } = usePanel()

  useKeyboardShortcuts({
    copyStreamLink: () => {
      if (getFocusedPane() === "panel" && panelId) {
        if (isConversationPanel(panelId)) {
          const conversationId = parseConversationPanel(panelId)
          if (conversationId) {
            void copyConversationLink(workspaceId, conversationId)
            return
          }
          // Malformed `conv:` id (hand-edited/stale URL) — fall through to the main link.
        } else if (!isDraftPanel(panelId)) {
          void copyStreamLink(workspaceId, panelId)
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
function WorkspaceSyncHandler({
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
  const isOnline = useOnlineStatus()
  const { streamId: currentStreamId } = useParams<{ streamId: string }>()
  const wasOfflineRef = useRef(!navigator.onLine)
  // Construct SyncEngine once per workspace. Use ref to survive StrictMode
  // double-render — useMemo + destroy effect breaks because the cleanup
  // destroys the engine before the socket connect effect fires.
  const syncEngineRef = useRef<SyncEngine | null>(null)
  let syncEngine = syncEngineRef.current
  if (!syncEngine || !isSyncEngineCurrent(syncEngine, workspaceId)) {
    syncEngine?.destroy()
    syncEngine = new SyncEngine({
      workspaceId,
      syncStatus: syncStatusStore!,
      queryClient,
      workspaceService,
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

  // Visibility-resume trigger: on phone/tab resume after a background gap,
  // probe the socket and refresh state. navigator.onLine doesn't flap in that
  // scenario and socket.io's native pingTimeout can take 20–25s to notice a
  // zombie transport. The 5s threshold is tight enough that a few seconds away
  // (a notification-shade peek that delivered a push, a brief tab switch) still
  // triggers a catch-up — the engine owns the whole resume window now, so there
  // is no separate lighter freshness hook below the probe threshold. The hook
  // stores the callback in a ref, so no memoization needed.
  usePageResume(() => {
    void syncEngine.handlePageResume()
  }, PAGE_RESUME_THRESHOLD_MS)

  // No destroy effect — StrictMode's effect cleanup cycle would destroy the
  // engine before the socket connect effect re-runs. The engine is destroyed
  // on workspace change (line above) and on page unload (browser handles it).

  // A push for a parked account stashes its recipient id (notification-intent);
  // flip the active account in place before this deep link bootstraps wrong.
  useNotificationAccountSwitch(workspaceId)

  // Terminal workspace error (404/403): a different signed-in account may own
  // this deep link — resolve→flip in place, else bounce to the list.
  useResolveOrBounce(workspaceId, syncEngine)

  return <SyncEngineContext.Provider value={syncEngine}>{children}</SyncEngineContext.Provider>
}

function MessageQueueHandler() {
  useMessageQueue()
  return null
}

/**
 * Pushes the `sharedWorkspaceReads` flag into the workspace-table registry. The
 * flag flips sharing only — the hook shape is identical in both arms — so it can
 * arrive late or change mid-session without changing a single hook count (D5).
 */
function WorkspaceReadModeSync({ workspaceId }: { workspaceId: string }) {
  const shared = useFeatureFlag(workspaceId, "sharedWorkspaceReads") === "on"

  useEffect(() => {
    setWorkspaceReadMode(shared ? "shared" : "off")
  }, [shared])

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
 * Publishes the URL-derived visible streams (main stream + bare-stream panels)
 * for push suppression. `conv:` panels resolve their stream ids only after
 * their post loads, so the conversation panel registers those itself.
 */
function VisibleStreamPresence({ streamIds }: { streamIds: string[] }) {
  useVisibleStreams(streamIds.filter(isServerStreamId))
  return null
}

function AppUpdateChecker() {
  useAppUpdate()
  return null
}

function FreshnessWatchers() {
  useBackgroundBootstrapSync()
  return null
}

function TraceDialogContainer() {
  const { isOpen } = useTrace()

  if (!isOpen) {
    return null
  }

  return <TraceDialog />
}

/** Bridges UserProfileProvider with MentionableMarkdownWrapper (INV-18: standalone component). */
function MentionableWrapper({ children, mentionables }: Omit<MentionableMarkdownWrapperProps, "onMentionClick">) {
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

export function WorkspaceLayout() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const [searchParams] = useSearchParams()
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [switcherMode, setSwitcherMode] = useState<QuickSwitcherMode>("stream")
  const { user, loading: authLoading } = useAuth()

  // Extract streamId from nested route (if on /s/:streamId)
  const streamMatch = useMatch("/w/:workspaceId/s/:streamId")
  const streamId = streamMatch?.params.streamId

  // Collect all stream IDs: main stream + any open panels
  const streamIds = useMemo(() => {
    const panelIds = searchParams.getAll("panel")
    return [streamId, ...panelIds].filter((id): id is string => Boolean(id))
  }, [streamId, searchParams])
  // A `conv:<id>` panel is not a stream: fetching its bootstrap 404s and joining
  // its room is rejected, and both delayed the coordinated reveal on every cold
  // open with a conversation panel in the URL. Same rule the SyncEngine and the
  // presence registration above already apply (INV-35).
  const coordinatedStreamIds = useMemo(() => streamIds.filter(isServerStreamId), [streamIds])

  const { mentionables } = useMentionables()
  const streams = useWorkspaceStreams(workspaceId ?? "")

  usePersistLastLocation(workspaceId)

  // Remember the workspace the user is in so the `/` entry route can redirect
  // straight here on a returning launch (renders from IndexedDB) instead of
  // routing through the control-plane workspace list. Only once auth resolved
  // to a real user so a pre-auth render can't pin a workspace.
  useEffect(() => {
    if (workspaceId && user) {
      setLastWorkspaceId(workspaceId)
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
            <VisibleStreamPresence streamIds={streamIds} />
            <AppUpdateChecker />
            <FreshnessWatchers />
            <MessageQueueHandler />
            <WorkspaceReadModeSync workspaceId={workspaceId} />
            <StreamNameDecryptor workspaceId={workspaceId} />
            <CoordinatedLoadingProvider workspaceId={workspaceId} streamIds={coordinatedStreamIds}>
              <ChannelLinkProvider workspaceId={workspaceId} streams={streams}>
                <CallLaunchProvider>
                  <UserProfileProvider>
                    <MentionableWrapper mentionables={mentionables}>
                      <WorkspaceCommandListProvider workspaceId={workspaceId}>
                        <WorkspaceEmojiProvider workspaceId={workspaceId}>
                          <PreferencesProvider workspaceId={workspaceId}>
                            <SettingsProvider>
                              <WorkspaceKeyboardHandler onOpenSwitcher={openSwitcher} currentStreamId={streamId}>
                                <E2eUnlockProvider workspaceId={workspaceId}>
                                  <QuickSwitcherProvider openSwitcher={openSwitcher}>
                                    <PanelProvider>
                                      <PerfCaptureConsentGate workspaceId={workspaceId} />
                                      <StreamLinkKeyboardHandler workspaceId={workspaceId} mainStreamId={streamId} />
                                      <EnclaveRewrapNudgeListener workspaceId={workspaceId} />
                                      <MediaGalleryProvider>
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
                                              <QuickSwitcher
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
                                          <TraceDialogContainer />
                                          <Toaster />
                                        </TraceProvider>
                                      </MediaGalleryProvider>
                                    </PanelProvider>
                                  </QuickSwitcherProvider>
                                </E2eUnlockProvider>
                              </WorkspaceKeyboardHandler>
                            </SettingsProvider>
                          </PreferencesProvider>
                        </WorkspaceEmojiProvider>
                      </WorkspaceCommandListProvider>
                    </MentionableWrapper>
                  </UserProfileProvider>
                  <CallDock />
                  <IncomingCallOverlay workspaceId={workspaceId} />
                </CallLaunchProvider>
              </ChannelLinkProvider>
            </CoordinatedLoadingProvider>
          </WorkspaceSyncHandler>
        </SocketProvider>
      </PerfCaptureProvider>
    </SyncStatusContext.Provider>
  )
}
