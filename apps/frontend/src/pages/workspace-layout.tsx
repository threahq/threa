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
} from "@/contexts"
import {
  useKeyboardShortcuts,
  useMentionables,
  usePersistLastStream,
  useAppUpdate,
  useMessageQueue,
  useUnreadTabIndicator,
  usePageResumeRefresh,
  useBackgroundBootstrapSync,
} from "@/hooks"
import { usePageResume } from "@/hooks/use-page-resume"
import { setLastWorkspaceId } from "@/lib/last-workspace"
import { useAuth } from "@/auth"
import { useWorkspaceStreams, useWorkspaceUsers } from "@/stores/workspace-store"
import { SyncEngine, SyncEngineContext } from "@/sync/sync-engine"
import { messagesApi } from "@/api"
import { QuickSwitcher, type QuickSwitcherMode } from "@/components/quick-switcher"
import { SettingsDialog } from "@/components/settings"
import { WorkspaceSettingsDialog } from "@/components/workspace-settings/workspace-settings-dialog"
import { AccountSwitcherDialog } from "@/components/account-switcher"
import { StreamSettingsDialog } from "@/components/stream-settings/stream-settings-dialog"
import { CreateChannelDialog } from "@/components/create-channel"
import { AttachmentExplorer, useExplorerUrlState } from "@/components/attachment-explorer"
import { TraceDialog } from "@/components/trace"
import { useQueryClient } from "@tanstack/react-query"
import { SyncStatusStore, SyncStatusContext } from "@/sync/sync-status"
import { useResolveOrBounce } from "./use-resolve-or-bounce"
import { useNotificationAccountSwitch } from "./use-notification-account-switch"

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
    openSearch: () => onOpenSwitcher("search"),
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
  const workspaceUsers = useWorkspaceUsers(workspaceId)
  const currentWorkspaceUserId = user ? (workspaceUsers.find((u) => u.workosUserId === user.id)?.id ?? null) : null

  // Construct SyncEngine once per workspace. Use ref to survive StrictMode
  // double-render — useMemo + destroy effect breaks because the cleanup
  // destroys the engine before the socket connect effect fires.
  const syncEngineRef = useRef<SyncEngine | null>(null)
  if (
    !syncEngineRef.current ||
    syncEngineRef.current.workspaceId !== workspaceId ||
    syncEngineRef.current.isDestroyed
  ) {
    syncEngineRef.current?.destroy()
    syncEngineRef.current = new SyncEngine({
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
    })
  }
  const syncEngine = syncEngineRef.current

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

  useEffect(() => {
    syncEngine.setCurrentWorkspaceUserId(currentWorkspaceUserId)
  }, [syncEngine, currentWorkspaceUserId])

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

  // Visibility-resume trigger: on phone/tab resume after long background,
  // probe the socket and refresh state. navigator.onLine doesn't flap in that
  // scenario and socket.io's native pingTimeout can take 20–25s to notice a
  // zombie transport. The hook stores the callback in a ref, so no memoization needed.
  usePageResume(() => {
    void syncEngine.handlePageResume()
  })

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

function UnreadTabIndicator({ workspaceId }: { workspaceId: string }) {
  useUnreadTabIndicator(workspaceId)
  return null
}

function AppUpdateChecker() {
  useAppUpdate()
  return null
}

function FreshnessWatchers() {
  usePageResumeRefresh()
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
    (slug: string, type: MentionType) => {
      if (type !== "user" && type !== "me") return
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

  const { mentionables } = useMentionables()
  const streams = useWorkspaceStreams(workspaceId ?? "")

  usePersistLastStream(workspaceId, streamId)

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
      <SocketProvider workspaceId={workspaceId}>
        <WorkspaceSyncHandler workspaceId={workspaceId} visibleStreamIds={streamIds}>
          <UnreadTabIndicator workspaceId={workspaceId} />
          <AppUpdateChecker />
          <FreshnessWatchers />
          <MessageQueueHandler />
          <CoordinatedLoadingProvider workspaceId={workspaceId} streamIds={streamIds}>
            <ChannelLinkProvider workspaceId={workspaceId} streams={streams}>
              <UserProfileProvider>
                <MentionableWrapper mentionables={mentionables}>
                  <WorkspaceCommandListProvider workspaceId={workspaceId}>
                    <WorkspaceEmojiProvider workspaceId={workspaceId}>
                      <PreferencesProvider workspaceId={workspaceId}>
                        <SettingsProvider>
                          <WorkspaceKeyboardHandler onOpenSwitcher={openSwitcher} currentStreamId={streamId}>
                            <QuickSwitcherProvider openSwitcher={openSwitcher}>
                              <PanelProvider>
                                <MediaGalleryProvider>
                                  <TraceProvider>
                                    <SidebarProvider>
                                      <SidebarKeyboardHandler />
                                      <CoordinatedLoadingGate>
                                        <AppShell sidebar={<Sidebar workspaceId={workspaceId} />}>
                                          <MainContentGate>
                                            <Outlet />
                                          </MainContentGate>
                                        </AppShell>
                                      </CoordinatedLoadingGate>
                                    </SidebarProvider>
                                    <QuickSwitcher
                                      workspaceId={workspaceId}
                                      open={switcherOpen}
                                      onOpenChange={setSwitcherOpen}
                                      initialMode={switcherMode}
                                    />
                                    <SettingsDialog />
                                    <WorkspaceSettingsDialog workspaceId={workspaceId} />
                                    <AccountSwitcherDialog />
                                    <StreamSettingsDialog workspaceId={workspaceId} />
                                    <CreateChannelDialog workspaceId={workspaceId} />
                                    <AttachmentExplorer workspaceId={workspaceId} />
                                    <TraceDialogContainer />
                                    <Toaster />
                                  </TraceProvider>
                                </MediaGalleryProvider>
                              </PanelProvider>
                            </QuickSwitcherProvider>
                          </WorkspaceKeyboardHandler>
                        </SettingsProvider>
                      </PreferencesProvider>
                    </WorkspaceEmojiProvider>
                  </WorkspaceCommandListProvider>
                </MentionableWrapper>
              </UserProfileProvider>
            </ChannelLinkProvider>
          </CoordinatedLoadingProvider>
        </WorkspaceSyncHandler>
      </SocketProvider>
    </SyncStatusContext.Provider>
  )
}
