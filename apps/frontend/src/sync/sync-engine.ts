import { createContext, useContext } from "react"
import type { Socket } from "socket.io-client"
import type { QueryClient } from "@tanstack/react-query"
import { db } from "@/db"
import { joinRoomFireAndForget, joinRoomBestEffort } from "@/lib/socket-room"
import { pingSocket } from "@/lib/socket-health"
import { ApiError } from "@/api/client"
import {
  applyReconnectBootstrapBatch,
  applyWorkspaceBootstrap,
  registerWorkspaceSocketHandlers,
} from "./workspace-sync"
import {
  applyStreamBootstrap,
  registerStreamSocketHandlers,
  getLatestPersistedSequence,
  toCachedStreamBootstrap,
  type CachedStreamBootstrap,
} from "./stream-sync"
import { processOperationQueue } from "./operation-queue"
import { SyncStatusStore } from "./sync-status"
import { streamKeys } from "@/hooks/use-streams"
import { workspaceKeys } from "@/hooks/use-workspaces"
import type { WorkspaceBootstrap } from "@threa/types"

interface SyncEngineDeps {
  workspaceId: string
  syncStatus: SyncStatusStore
  queryClient: QueryClient
  workspaceService: { bootstrap: (workspaceId: string) => Promise<WorkspaceBootstrap> }
  streamService: {
    bootstrap: (
      workspaceId: string,
      streamId: string,
      params?: { after?: string }
    ) => Promise<import("@threa/types").StreamBootstrap>
  }
  messageService?: {
    update: (workspaceId: string, messageId: string, data: any) => Promise<any>
    delete: (workspaceId: string, messageId: string) => Promise<void>
  }
  reactionService?: {
    add: (workspaceId: string, messageId: string, emoji: string) => Promise<void>
    remove: (workspaceId: string, messageId: string, emoji: string) => Promise<void>
  }
  scheduledService?: {
    create: (
      workspaceId: string,
      input: import("@threa/types").ScheduleMessageInput
    ) => Promise<import("@threa/types").ScheduledMessageView>
    delete: (workspaceId: string, id: string) => Promise<void>
    sendNow: (workspaceId: string, id: string) => Promise<import("@threa/types").ScheduledMessageView>
  }
}

/**
 * Owns the full sync lifecycle for a workspace:
 * - Workspace bootstrap (subscribe-then-fetch, INV-53)
 * - Stream subscriptions (subscribe-then-fetch per stream)
 * - Socket handler registration (workspace + stream level)
 * - Reconnection (re-bootstrap everything)
 * - Sync status tracking
 *
 * Constructed once per workspace and provided via context.
 * Testable without React (plain class, no hooks).
 */
export class SyncEngine {
  private socket: Socket | null = null
  private subscribedStreams = new Set<string>()
  private streamHandlerCleanups = new Map<string, () => void>()
  private workspaceHandlerCleanup: (() => void) | null = null
  private activeBootstrap: Promise<void> | null = null
  private queuedReconnectBootstrap: Promise<void> | null = null
  private activeStreamRefreshes = new Map<string, Promise<void>>()
  private hasEverConnected = false
  /** Whether the engine has been destroyed. Public for ref-check re-creation. */
  isDestroyed = false

  // Ref-like state updated by the React layer
  private currentStreamId: string | undefined = undefined
  private visibleStreamIds: string[] = []
  private currentUser: { id: string } | null = null
  /**
   * Workspace-scoped user id (`UserId`) for the active session — distinct
   * from `currentUser.id`, which is the WorkOS auth id. The E2E session
   * store keys by workspace user id (the same id stored in `e2e_keys` and
   * on `e2e_scratchpads`), so the message decrypt path needs this one.
   * Resolved by the React layer once `useWorkspaceUsers` has the row.
   */
  private currentWorkspaceUserId: string | null = null
  /** Last workspace bootstrap error, if any. Consumers can check this for 404/403 handling. */
  lastWorkspaceError: unknown = null

  readonly workspaceId: string

  constructor(private deps: SyncEngineDeps) {
    this.workspaceId = deps.workspaceId
  }

  /** Update the current stream ID (called from React when route changes). */
  setCurrentStreamId(id: string | undefined): void {
    if (this.currentStreamId === id) return
    this.currentStreamId = id
    if (id) {
      void this.refreshStreamAfterNavigation(id)
    }
  }

  setVisibleStreamIds(ids: string[]): void {
    this.visibleStreamIds = ids
  }

  /** Update the current auth user (called from React when auth state settles). */
  setCurrentUser(user: { id: string } | null): void {
    this.currentUser = user
  }

  /** Update the workspace-scoped user id (called from React once `useWorkspaceUsers` resolves it). */
  setCurrentWorkspaceUserId(id: string | null): void {
    this.currentWorkspaceUserId = id
  }

  /**
   * Called when the socket connects or reconnects.
   * Triggers full bootstrap cycle: workspace → member streams.
   */
  async onConnect(socket: Socket): Promise<void> {
    if (this.isDestroyed) return
    const isReconnect = this.hasEverConnected
    this.hasEverConnected = true
    this.socket = socket

    if (isReconnect) {
      this.deps.syncStatus.setAllStale()
      // Clean up old handlers before re-registering
      this.cleanupWorkspaceHandlers()
      this.cleanupStreamHandlers()
    }

    // Register workspace-level socket handlers (stream:created, stream:updated, etc.)
    this.workspaceHandlerCleanup = registerWorkspaceSocketHandlers(
      socket,
      this.deps.workspaceId,
      this.deps.queryClient,
      {
        getCurrentStreamId: () => this.currentStreamId,
        getCurrentUser: () => this.currentUser,
        subscribeStream: (streamId: string) => void this.subscribeStream(streamId),
      }
    )

    await this.runBootstrap(isReconnect)

    // Process pending offline operations (edits, deletes, reactions)
    this.kickOperationQueue()
  }

  /**
   * Rehydrate visible streams after a connectivity gap even if Socket.IO did
   * not emit a full reconnect cycle (for example, brief offline gaps where the
   * transport survives but the client missed stream updates).
   */
  async refreshAfterConnectivityResume(): Promise<void> {
    if (this.isDestroyed) return
    await this.runBootstrap(true)
  }

  /**
   * Called when the page resumes from a long hidden period (e.g. phone
   * unlocked after app-switch). Probes the socket for liveness; if the
   * probe fails, forces a reconnect to short-circuit socket.io's 20–25s
   * native zombie detection. If the probe succeeds, refreshes state since
   * events may have been missed while the page was backgrounded.
   */
  async handlePageResume(): Promise<void> {
    if (this.isDestroyed || !this.socket || !this.hasEverConnected) return
    // If the transport is already down, socket.io is handling the reconnect;
    // don't layer another probe on top of it.
    if (!this.socket.connected) return

    const healthy = await pingSocket(this.socket)
    if (this.isDestroyed) return

    if (!healthy) {
      // Manual disconnect disables socket.io's auto-reconnect, so connect explicitly.
      // onConnect(isReconnect=true) will drive the fresh bootstrap cycle.
      this.socket.disconnect()
      this.socket.connect()
      return
    }

    await this.refreshAfterConnectivityResume()
  }

  /**
   * Called when the socket disconnects.
   */
  onDisconnect(): void {
    this.deps.syncStatus.setAllStale()
  }

  /**
   * Subscribe to a stream: join room, register handlers, fetch bootstrap.
   * Called by stream view components when they mount.
   * Idempotent — no-op if already subscribed.
   */
  async subscribeStream(streamId: string): Promise<void> {
    if (this.isDestroyed || !this.socket) return
    await this.ensureStreamSubscription(streamId)
  }

  /**
   * Unsubscribe from a stream. Called when stream view unmounts.
   * Cleans up the stream's socket handlers to prevent accumulation.
   */
  unsubscribeStream(streamId: string): void {
    this.subscribedStreams.delete(streamId)
    const cleanup = this.streamHandlerCleanups.get(streamId)
    if (cleanup) {
      cleanup()
      this.streamHandlerCleanups.delete(streamId)
    }
  }

  /**
   * Kick the offline operation queue (edits, deletes, reactions).
   * Called on connect and can be called after enqueueOperation.
   */
  kickOperationQueue(): void {
    if (!this.deps.messageService) return
    void processOperationQueue(
      this.deps.messageService,
      this.deps.reactionService ?? { add: async () => {}, remove: async () => {} },
      this.deps.scheduledService,
      () => this.socket !== null && !this.isDestroyed
    )
  }

  /**
   * Re-trigger workspace bootstrap (e.g., user clicks "Retry" in sidebar error).
   */
  retryWorkspace(): void {
    if (!this.socket) return
    void this.runBootstrap(false)
  }

  /**
   * Tear down all subscriptions and handlers.
   * Called when the workspace layout unmounts.
   */
  destroy(): void {
    this.isDestroyed = true
    this.cleanupAllHandlers()
    this.subscribedStreams.clear()
    this.socket = null
  }

  // =========================================================================
  // Internal
  // =========================================================================

  private async bootstrapWorkspace(_isReconnect: boolean): Promise<void> {
    const { workspaceId, syncStatus, queryClient, workspaceService, streamService } = this.deps

    syncStatus.set(`workspace:${workspaceId}`, "syncing")

    const visibleStreamIds = _isReconnect ? this.getVisibleServerStreamIds() : []
    for (const streamId of visibleStreamIds) {
      syncStatus.set(`stream:${streamId}`, "syncing")
      syncStatus.setError(`stream:${streamId}`, null)
    }

    try {
      // Subscribe-then-fetch (INV-53). Soft refresh can run while the socket
      // client is still reconnecting; in that case we still fetch fresh
      // bootstrap data and skip the room-join step.
      if (this.socket) {
        await joinRoomBestEffort(this.socket, `ws:${workspaceId}`, "SyncEngine")
      }

      const fetchStartedAt = Date.now()
      let bootstrap: WorkspaceBootstrap

      if (_isReconnect && visibleStreamIds.length > 0) {
        await Promise.all(
          visibleStreamIds.map((streamId) => this.ensureStreamSubscription(streamId, { awaitJoin: true }))
        )

        const [workspaceBootstrap, streamResults] = await Promise.all([
          workspaceService.bootstrap(workspaceId),
          Promise.all(
            visibleStreamIds.map(async (streamId) => {
              try {
                const after = await getLatestPersistedSequence(streamId)
                const bootstrap = await streamService.bootstrap(workspaceId, streamId, after ? { after } : undefined)
                return { streamId, bootstrap }
              } catch (error) {
                return { streamId, error }
              }
            })
          ),
        ])

        const successfulStreamBootstraps = new Map<string, import("@threa/types").StreamBootstrap>()
        const staleStreamIds = new Set<string>()
        const terminalStreamIds = new Set<string>()
        for (const result of streamResults) {
          if ("bootstrap" in result && result.bootstrap) {
            successfulStreamBootstraps.set(result.streamId, result.bootstrap)
          } else {
            if (ApiError.isApiError(result.error) && (result.error.status === 403 || result.error.status === 404)) {
              terminalStreamIds.add(result.streamId)
            } else {
              staleStreamIds.add(result.streamId)
            }
            this.applyReconnectStreamError(result.streamId, result.error)
          }
        }

        const workspaceStreamIds = new Set(workspaceBootstrap.streams.map((stream) => stream.id))
        for (const streamId of visibleStreamIds) {
          if (successfulStreamBootstraps.has(streamId) || workspaceStreamIds.has(streamId)) continue
          terminalStreamIds.add(streamId)
          // Only synthesize a 404 if no precise error was recorded in the first
          // pass — otherwise a 403 from a stream the server omitted from the
          // fresh workspace bootstrap would get overwritten to "not found" and
          // surface the wrong error message to the user.
          if (!this.deps.syncStatus.getError(`stream:${streamId}`)) {
            this.deps.syncStatus.setError(`stream:${streamId}`, {
              status: 404,
              error: new ApiError(404, "STREAM_NOT_FOUND", "Stream not found"),
            })
          }
        }

        bootstrap = await applyReconnectBootstrapBatch(
          workspaceId,
          workspaceBootstrap,
          successfulStreamBootstraps,
          staleStreamIds,
          terminalStreamIds,
          fetchStartedAt,
          this.currentWorkspaceUserId
        )

        queryClient.setQueryData(workspaceKeys.bootstrap(workspaceId), bootstrap)
        for (const [streamId, streamBootstrap] of successfulStreamBootstraps) {
          queryClient.setQueryData(
            streamKeys.bootstrap(workspaceId, streamId),
            toCachedStreamBootstrap(
              streamBootstrap,
              queryClient.getQueryData<CachedStreamBootstrap>(streamKeys.bootstrap(workspaceId, streamId)),
              { incrementWindowVersionOnReplace: streamBootstrap.syncMode === "replace" }
            )
          )
          syncStatus.setError(`stream:${streamId}`, null)
          syncStatus.set(`stream:${streamId}`, "synced")
        }
        for (const streamId of [...staleStreamIds, ...terminalStreamIds]) {
          const status = syncStatus.getError(`stream:${streamId}`) ? "error" : "stale"
          syncStatus.set(`stream:${streamId}`, status)
        }
      } else {
        bootstrap = await workspaceService.bootstrap(workspaceId)

        // Write to IDB (source of truth)
        await applyWorkspaceBootstrap(workspaceId, bootstrap, fetchStartedAt)

        // Write to TanStack cache (bridge for coordinated-loading, sidebar loading/error)
        queryClient.setQueryData(workspaceKeys.bootstrap(workspaceId), bootstrap)
      }

      this.lastWorkspaceError = null
      syncStatus.set(`workspace:${workspaceId}`, "synced")

      // Subscribe all member streams
      const memberStreamIds = bootstrap.streamMemberships.map((sm) => sm.streamId)
      // Subscribe all member streams: join rooms + register socket handlers.
      // On reconnect, cleanupStreamHandlers() already cleared the old handlers,
      // so these are fresh registrations.
      for (const streamId of memberStreamIds) {
        if (!this.subscribedStreams.has(streamId)) {
          await this.ensureStreamSubscription(streamId)
        }
      }
    } catch (error) {
      this.lastWorkspaceError = error
      const hasCachedData = (await db.workspaces.get(workspaceId)) !== undefined
      syncStatus.set(`workspace:${workspaceId}`, hasCachedData ? "stale" : "error")
      for (const streamId of visibleStreamIds) {
        if (syncStatus.get(`stream:${streamId}`) === "syncing") {
          syncStatus.set(`stream:${streamId}`, "stale")
        }
      }

      if (!hasCachedData) {
        // Propagate to TanStack so coordinated-loading shows the error
        queryClient.setQueryData(workspaceKeys.bootstrap(workspaceId), undefined)
      }
    }
  }

  private runBootstrap(isReconnect: boolean): Promise<void> {
    if (this.activeBootstrap) {
      // If a reconnect arrives while a non-reconnect bootstrap (e.g.
      // retryWorkspace) is in flight, we can't mutate the in-flight request
      // to upgrade its semantics — it already chose visibleStreamIds=[] and
      // won't do the per-stream delta fetch. Chain a follow-up reconnect
      // bootstrap so the visible streams get their delta fetch once the
      // current bootstrap finishes. Repeat reconnect triggers collapse onto
      // the same queued promise.
      if (isReconnect && !this.queuedReconnectBootstrap) {
        const chained = this.activeBootstrap
          .catch(() => {
            // Swallow — the follow-up reconnect will retry whatever failed.
          })
          .then(() => {
            this.queuedReconnectBootstrap = null
            return this.runBootstrap(true)
          })
        this.queuedReconnectBootstrap = chained
      }
      return this.queuedReconnectBootstrap ?? this.activeBootstrap
    }

    const bootstrapPromise = this.bootstrapWorkspace(isReconnect).finally(() => {
      if (this.activeBootstrap === bootstrapPromise) {
        this.activeBootstrap = null
      }
    })

    this.activeBootstrap = bootstrapPromise
    return bootstrapPromise
  }

  private getVisibleServerStreamIds(): string[] {
    const streamIds = this.currentStreamId ? [this.currentStreamId, ...this.visibleStreamIds] : this.visibleStreamIds
    return Array.from(
      new Set(streamIds.filter((streamId) => !streamId.startsWith("draft_") && !streamId.startsWith("draft:")))
    )
  }

  private async ensureStreamSubscription(streamId: string, options?: { awaitJoin?: boolean }): Promise<void> {
    if (!this.socket || this.isDestroyed) return

    if (!this.subscribedStreams.has(streamId)) {
      this.subscribedStreams.add(streamId)
      const cleanup = registerStreamSocketHandlers(
        this.socket,
        this.deps.workspaceId,
        streamId,
        this.deps.queryClient,
        {
          getCurrentUserId: () => this.currentWorkspaceUserId,
        }
      )
      this.streamHandlerCleanups.set(streamId, cleanup)
    }

    const room = `ws:${this.deps.workspaceId}:stream:${streamId}`
    if (options?.awaitJoin) {
      await joinRoomBestEffort(this.socket, room, "SyncEngine")
      return
    }

    joinRoomFireAndForget(this.socket, room, new AbortController().signal, "SyncEngine")
  }

  private refreshStreamAfterNavigation(streamId: string): Promise<void> {
    if (
      this.isDestroyed ||
      !this.socket ||
      !this.socket.connected ||
      streamId.startsWith("draft_") ||
      streamId.startsWith("draft:")
    ) {
      return Promise.resolve()
    }

    const existing = this.activeStreamRefreshes.get(streamId)
    if (existing) return existing

    const refresh = this.performStreamRefresh(streamId).finally(() => {
      if (this.activeStreamRefreshes.get(streamId) === refresh) {
        this.activeStreamRefreshes.delete(streamId)
      }
    })
    this.activeStreamRefreshes.set(streamId, refresh)
    return refresh
  }

  private async performStreamRefresh(streamId: string): Promise<void> {
    const { workspaceId, syncStatus, streamService, queryClient } = this.deps
    const key = `stream:${streamId}`

    syncStatus.set(key, "syncing")
    syncStatus.setError(key, null)

    try {
      await this.ensureStreamSubscription(streamId, { awaitJoin: true })
      if (this.isDestroyed) return

      const queryKey = streamKeys.bootstrap(workspaceId, streamId)
      const previousBootstrap = queryClient.getQueryData<CachedStreamBootstrap>(queryKey)
      const after = previousBootstrap ? await getLatestPersistedSequence(streamId) : null
      const bootstrap = await streamService.bootstrap(workspaceId, streamId, after ? { after } : undefined)
      await applyStreamBootstrap(workspaceId, streamId, bootstrap, this.currentWorkspaceUserId)

      queryClient.setQueryData<CachedStreamBootstrap>(queryKey, (currentBootstrap) =>
        toCachedStreamBootstrap(bootstrap, currentBootstrap ?? previousBootstrap, {
          incrementWindowVersionOnReplace: bootstrap.syncMode === "replace",
        })
      )
      syncStatus.set(key, "synced")
    } catch (error) {
      this.applyReconnectStreamError(streamId, error)
      syncStatus.set(key, syncStatus.getError(key) ? "error" : "stale")
    }
  }

  private applyReconnectStreamError(streamId: string, error: unknown): void {
    const key = `stream:${streamId}`
    if (ApiError.isApiError(error) && (error.status === 403 || error.status === 404)) {
      this.deps.syncStatus.setError(key, { status: error.status, error })
      return
    }

    this.deps.syncStatus.setError(key, null)
  }

  private cleanupWorkspaceHandlers(): void {
    if (this.workspaceHandlerCleanup) {
      this.workspaceHandlerCleanup()
      this.workspaceHandlerCleanup = null
    }
  }

  private cleanupStreamHandlers(): void {
    for (const cleanup of this.streamHandlerCleanups.values()) cleanup()
    this.streamHandlerCleanups.clear()
    this.subscribedStreams.clear()
  }

  private cleanupAllHandlers(): void {
    this.cleanupWorkspaceHandlers()
    this.cleanupStreamHandlers()
  }
}

// React context for accessing the SyncEngine from any component
export const SyncEngineContext = createContext<SyncEngine | null>(null)

export function useSyncEngine(): SyncEngine {
  const engine = useContext(SyncEngineContext)
  if (!engine) throw new Error("useSyncEngine must be used within a SyncEngineContext provider")
  return engine
}

export function useOptionalSyncEngine(): SyncEngine | null {
  return useContext(SyncEngineContext)
}
