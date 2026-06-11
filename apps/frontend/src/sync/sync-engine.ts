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
import { waitForInitialReveal } from "./reveal-gate"
import { SyncLogCursor, SYNC_V2_CURSOR_SHADOW_DEFAULT } from "./sync-log-cursor"
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
  syncService?: {
    catchUp: (
      workspaceId: string,
      params: { after: string; limit?: number },
      signal?: AbortSignal
    ) => Promise<import("@threa/types").SyncCatchUpResponse>
  }
  /** Test override for the VITE_SYNC_V2_CURSOR flag. */
  syncCursorShadowEnabled?: boolean
}

/** Safety valve for shadow catch-up paging (20 pages × 500 entries). */
const MAX_SHADOW_CATCHUP_PAGES = 20
const SHADOW_CATCHUP_PAGE_LIMIT = 500

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
  private activeGapBackfills = new Map<string, { cursor: string; promise: Promise<void> }>()
  /** Lowest gap cursor reported per stream while a backfill was in flight —
   *  drained into one follow-up backfill when the active one settles. */
  private queuedGapCursors = new Map<string, string>()
  private hasEverConnected = false
  /** Whether the engine has been destroyed. Public for ref-check re-creation. */
  isDestroyed = false

  // Sync-engine v2 cursor (shadow mode): one lastSyncId per workspace,
  // advanced by live events and exercised against the catch-up endpoint
  // without owning any healing yet. See sync-log-cursor.ts.
  private readonly syncCursorShadowEnabled: boolean
  private syncLogCursor: SyncLogCursor | null = null
  private syncCursorCleanup: (() => void) | null = null
  private activeShadowCatchUp: Promise<void> | null = null
  private shadowCatchUpAbort: AbortController | null = null

  // Ref-like state updated by the React layer
  private currentStreamId: string | undefined = undefined
  private visibleStreamIds: string[] = []
  private currentUser: { id: string } | null = null
  /** Last workspace bootstrap error, if any. Consumers can check this for 404/403 handling. */
  lastWorkspaceError: unknown = null

  readonly workspaceId: string

  constructor(private deps: SyncEngineDeps) {
    this.workspaceId = deps.workspaceId
    this.syncCursorShadowEnabled = (deps.syncCursorShadowEnabled ?? SYNC_V2_CURSOR_SHADOW_DEFAULT) && !!deps.syncService
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

    if (this.syncCursorShadowEnabled) {
      this.trackSyncCursor(socket)
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

    // Shadow only — runs after bootstrap so it never competes for the
    // connection setup window, and applies nothing.
    void this.runShadowCatchUp(isReconnect ? "reconnect" : "connect")
  }

  /**
   * Rehydrate visible streams after a connectivity gap even if Socket.IO did
   * not emit a full reconnect cycle (for example, brief offline gaps where the
   * transport survives but the client missed stream updates).
   */
  async refreshAfterConnectivityResume(): Promise<void> {
    if (this.isDestroyed) return
    await this.runBootstrap(true)
    void this.runShadowCatchUp("resume")
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

  /** Current sync-log cursor (v2 shadow), or null when none is tracked yet. */
  getSyncCursor(): string | null {
    return this.syncLogCursor?.get() ?? null
  }

  /**
   * Close a detected sequence gap: a live socket event arrived whose sequence
   * leaves a hole behind the previously-latest persisted event, meaning events
   * were missed while this client wasn't receiving (zombie socket, server
   * bounce, a reconnect catch-up that raced live delivery). Fetches events
   * after the PRE-GAP cursor — the current latest would skip the very hole
   * this is meant to fill — and applies them append-style (INV-53).
   *
   * Single-flighted per stream: duplicate reports of the SAME gap (the engine
   * and the stream-view hook both register handlers, so each gap fires twice)
   * collapse onto the in-flight fetch. A report with a DIFFERENT cursor while
   * one is in flight is a distinct gap whose events may have committed after
   * the active fetch's server read — it is queued (lowest cursor wins) and
   * drained into one follow-up backfill when the active one settles, instead
   * of being silently dropped.
   */
  backfillStreamGap(streamId: string, afterSequence: string): Promise<void> {
    if (this.isDestroyed) return Promise.resolve()
    const active = this.activeGapBackfills.get(streamId)
    if (active) {
      if (active.cursor !== afterSequence) {
        const queued = this.queuedGapCursors.get(streamId)
        if (queued === undefined || BigInt(afterSequence) < BigInt(queued)) {
          this.queuedGapCursors.set(streamId, afterSequence)
        }
      }
      return active.promise
    }

    const { workspaceId, streamService, queryClient } = this.deps
    const promise = (async () => {
      try {
        const bootstrap = await streamService.bootstrap(workspaceId, streamId, { after: afterSequence })
        if (this.isDestroyed) return
        await applyStreamBootstrap(workspaceId, streamId, bootstrap)
        queryClient.setQueryData<CachedStreamBootstrap>(streamKeys.bootstrap(workspaceId, streamId), (current) =>
          current
            ? toCachedStreamBootstrap(bootstrap, current, {
                incrementWindowVersionOnReplace: bootstrap.syncMode === "replace",
              })
            : current
        )
        // Clear any stale marker a prior failed backfill (or a degraded
        // reconnect) left behind — the gap is closed and the stream is current.
        this.deps.syncStatus.setError(`stream:${streamId}`, null)
        this.deps.syncStatus.set(`stream:${streamId}`, "synced")
      } catch (error) {
        // Best-effort: the gap stays in the local cache and the next
        // reconnect/navigation bootstrap closes it. Mark the stream stale so
        // the sync indicator reflects the known divergence.
        this.deps.syncStatus.set(`stream:${streamId}`, "stale")
        console.error("Sequence-gap backfill failed", { streamId, afterSequence, error })
      }
    })().finally(() => {
      if (this.activeGapBackfills.get(streamId)?.promise === promise) {
        this.activeGapBackfills.delete(streamId)
      }
      const queued = this.queuedGapCursors.get(streamId)
      if (queued !== undefined) {
        this.queuedGapCursors.delete(streamId)
        void this.backfillStreamGap(streamId, queued)
      }
    })
    this.activeGapBackfills.set(streamId, { cursor: afterSequence, promise })
    return promise
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
    // Dispose without flushing — destroy can be an account switch that
    // repoints the shared db proxy, and the cursor must not leak across
    // accounts. See SyncLogCursor.
    this.shadowCatchUpAbort?.abort()
    this.shadowCatchUpAbort = null
    this.syncLogCursor?.dispose()
    this.syncLogCursor = null
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
        // Cursor-before-join per stream is owned by joinStreamForCatchUp —
        // see its doc for why the order is load-bearing (INV-53).
        const catchupCursors = new Map<string, string | null>()
        await Promise.all(
          visibleStreamIds.map(async (streamId) => {
            catchupCursors.set(streamId, await this.joinStreamForCatchUp(streamId))
          })
        )

        const [workspaceBootstrap, streamResults] = await Promise.all([
          workspaceService.bootstrap(workspaceId),
          Promise.all(
            visibleStreamIds.map(async (streamId) => {
              try {
                const after = catchupCursors.get(streamId) ?? null
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

        const { workspaceBootstrap: appliedWorkspaceBootstrap, streamBootstraps: appliedStreamBootstraps } =
          await applyReconnectBootstrapBatch(
            workspaceId,
            workspaceBootstrap,
            successfulStreamBootstraps,
            staleStreamIds,
            terminalStreamIds,
            fetchStartedAt
          )
        bootstrap = appliedWorkspaceBootstrap

        queryClient.setQueryData(workspaceKeys.bootstrap(workspaceId), bootstrap)
        // Seed the per-stream TanStack cache from the bootstraps we just
        // applied. E2E payloads stay as ciphertext + envelope here — the
        // render layer decrypts in memory via `useDecryptedMessageContent`.
        for (const [streamId, streamBootstrap] of appliedStreamBootstraps) {
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
        // Fire the fetch immediately — freshness is never deferred over the wire.
        bootstrap = await workspaceService.bootstrap(workspaceId)

        // On the very first connect of a warm start, hold the IndexedDB write
        // until the cached reveal has painted. applyWorkspaceBootstrap writes the
        // same stores the reveal reads, and IndexedDB serializes readwrite
        // against readonly, so an un-gated write here queues the reveal's reads
        // behind it — the reason an online start lagged an offline one. The fetch
        // above already ran in parallel with the reveal, so this only delays the
        // write by the (bounded) time the paint needs. Skipped on reconnects
        // (content already on screen), where the write must land promptly. See
        // reveal-gate.ts.
        if (!_isReconnect) {
          // Only defer when the cache is complete enough for the gate to reveal
          // WITHOUT this write. The coordinated-loading gate holds its reveal
          // until the workspace row plus the unread / metadata / sidebar
          // singletons are all present (see coordinated-loading-context.tsx's
          // `workspaceDataReady`). If any are missing — a cold start, or a
          // partial cache from an interrupted/upgraded prior session — the gate
          // can only become ready once THIS write lands, so waiting on the
          // reveal would deadlock until the timeout. In that case we write
          // immediately and let the gate reveal off the fresh write.
          const [workspace, unreadState, metadata, sidebarConfig] = await Promise.all([
            db.workspaces.get(workspaceId),
            db.unreadState.get(workspaceId),
            db.workspaceMetadata.get(workspaceId),
            db.sidebarConfigs.get(workspaceId),
          ])
          const canRevealFromCache = !!workspace && !!unreadState && !!metadata && !!sidebarConfig
          if (canRevealFromCache) await waitForInitialReveal(workspaceId)
        }

        // An account/workspace switch tears this engine down (isDestroyed) and
        // repoints the shared `db` proxy + queryClient before the new subtree
        // mounts. Any await above (the fetch, the cache probe, the reveal wait)
        // can outlive that switch, so bail before writing — otherwise this stale
        // bootstrap lands in the newly-active account's IDB and cache.
        if (this.isDestroyed) return

        // Write to IDB (source of truth)
        await applyWorkspaceBootstrap(workspaceId, bootstrap, fetchStartedAt)

        // Write to TanStack cache (bridge for coordinated-loading, sidebar loading/error)
        queryClient.setQueryData(workspaceKeys.bootstrap(workspaceId), bootstrap)
      }

      this.lastWorkspaceError = null
      syncStatus.set(`workspace:${workspaceId}`, "synced")

      // Subscribe all member streams: join rooms + register socket handlers.
      // On reconnect, cleanupStreamHandlers() already cleared the old handlers,
      // so these are fresh registrations.
      await this.subscribeMemberStreams(bootstrap.streamMemberships.map((sm) => sm.streamId))
    } catch (error) {
      this.lastWorkspaceError = error
      const hasCachedData = (await db.workspaces.get(workspaceId)) !== undefined
      syncStatus.set(`workspace:${workspaceId}`, hasCachedData ? "stale" : "error")
      for (const streamId of visibleStreamIds) {
        if (syncStatus.get(`stream:${streamId}`) === "syncing") {
          syncStatus.set(`stream:${streamId}`, "stale")
        }
      }

      if (hasCachedData) {
        // The fresh bootstrap failed but cached data is already on screen. Join
        // the member-stream rooms from the cached membership list anyway, so
        // `stream:activity` — which carries the sidebar unread bump *and* the
        // last-message preview that powers hover-to-preview — keeps flowing onto
        // the cached rows instead of going dark until the user opens each stream.
        // This mirrors the success-path subscription (member rooms only ever
        // carry sidebar-level deltas; the per-stream bootstrap fetch happens on
        // navigation). The next successful bootstrap re-applies authoritative
        // counts/previews, closing any gap (INV-53).
        await this.subscribeMemberStreams(await this.cachedMemberStreamIds())
      } else {
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

  /**
   * Join rooms + register socket handlers for a set of member streams.
   * Idempotent per stream — skips ones already subscribed. Runs on every
   * bootstrap (success path and the cache-only failure path) so `stream:activity`
   * reaches every stream the user belongs to, not just the ones they opened this
   * session. Without it the sidebar unread badge and hover-to-preview only update
   * for streams whose room the user has explicitly joined.
   */
  private async subscribeMemberStreams(streamIds: string[]): Promise<void> {
    for (const streamId of streamIds) {
      if (!this.subscribedStreams.has(streamId)) {
        await this.ensureStreamSubscription(streamId)
      }
    }
  }

  /** Member stream ids from the offline cache, for the bootstrap-failure path. */
  private async cachedMemberStreamIds(): Promise<string[]> {
    const memberships = await db.streamMemberships.where("workspaceId").equals(this.deps.workspaceId).toArray()
    return memberships.map((membership) => membership.streamId)
  }

  /**
   * The single owner of catch-up-cursor derivation (INV-53, INV-61): read
   * the stream's latest persisted sequence, THEN join its room — in that
   * order. Once subscribed, live events land in IndexedDB immediately, and a
   * message landing before the cursor read would advance the cursor past the
   * disconnect gap, making the subsequent `bootstrap?after=` fetch
   * permanently skip everything missed while offline (the "older message
   * never appears while newer ones do" bug). Overlap is safe (writes dedupe
   * by event id); gaps are not.
   *
   * Callers must never read `getLatestPersistedSequence` and order it
   * against a room join themselves. The one other cursor source is
   * `backfillStreamGap`, which intentionally uses an explicit PRE-GAP cursor
   * (the current latest would skip the very hole it fills).
   */
  private async joinStreamForCatchUp(streamId: string): Promise<string | null> {
    const after = await getLatestPersistedSequence(streamId)
    await this.ensureStreamSubscription(streamId, { awaitJoin: true })
    return after
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
          onSequenceGap: ({ streamId: gapStreamId, afterSequence }) =>
            void this.backfillStreamGap(gapStreamId, afterSequence),
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
      const queryKey = streamKeys.bootstrap(workspaceId, streamId)
      const previousBootstrap = queryClient.getQueryData<CachedStreamBootstrap>(queryKey)
      const cursor = await this.joinStreamForCatchUp(streamId)
      if (this.isDestroyed) return
      // Without a cached bootstrap this is a fresh open, not a catch-up —
      // fetch the full latest window instead of an append from the cursor.
      const after = previousBootstrap ? cursor : null

      const bootstrap = await streamService.bootstrap(workspaceId, streamId, after ? { after } : undefined)
      await applyStreamBootstrap(workspaceId, streamId, bootstrap)

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

  /**
   * Shadow-mode half of the v2 live path: every socket event whose payload
   * carries a `syncId` for this workspace advances the cursor. Events
   * without one are bot-scoped or pre-deploy and stay invisible to the
   * cursor. Registered with `onAny` so all 40+ event types hit one
   * chokepoint instead of 40 handler edits.
   */
  private trackSyncCursor(socket: Socket): void {
    this.syncLogCursor ??= new SyncLogCursor(this.workspaceId)
    void this.syncLogCursor.load()

    this.cleanupSyncCursorTracking()
    const listener = (_event: string, ...args: unknown[]) => {
      const payload = args[0] as { workspaceId?: unknown; syncId?: unknown } | undefined
      if (!payload || payload.workspaceId !== this.workspaceId || typeof payload.syncId !== "string") return
      this.syncLogCursor?.advance(payload.syncId)
    }
    socket.onAny(listener)
    this.syncCursorCleanup = () => socket.offAny(listener)
  }

  /**
   * Shadow-mode catch-up: pages the sync endpoint from the cursor and logs
   * what active mode WOULD have applied, applying nothing. Entries fetched
   * here are events the live path never advanced past — after a disconnect
   * that count is the healing the cursor will own; on a healthy resume it
   * should be ~zero. Single-flighted; never throws into callers.
   */
  private runShadowCatchUp(trigger: string): Promise<void> {
    if (!this.syncCursorShadowEnabled || this.isDestroyed) return Promise.resolve()
    if (this.activeShadowCatchUp) return this.activeShadowCatchUp

    const abort = new AbortController()
    this.shadowCatchUpAbort = abort
    const promise = this.performShadowCatchUp(trigger, abort.signal)
      .catch((error) => {
        // A destroy-triggered abort is expected teardown, not a failure.
        if (this.isDestroyed) return
        console.error("Sync-v2 shadow catch-up failed", { workspaceId: this.workspaceId, trigger, error })
      })
      .finally(() => {
        if (this.activeShadowCatchUp === promise) {
          this.activeShadowCatchUp = null
        }
        if (this.shadowCatchUpAbort === abort) {
          this.shadowCatchUpAbort = null
        }
      })
    this.activeShadowCatchUp = promise
    return promise
  }

  private async performShadowCatchUp(trigger: string, signal: AbortSignal): Promise<void> {
    const syncService = this.deps.syncService!
    const cursorStore = (this.syncLogCursor ??= new SyncLogCursor(this.workspaceId))
    await cursorStore.load()

    const cursorBefore = cursorStore.get()
    if (cursorBefore === null) {
      // No cursor yet (first run on this device): seed from head instead of
      // replaying the whole retained log — everything at or below head is
      // covered by the bootstrap snapshot path. NOTE: this jump is legal
      // only because shadow mode owns no healing. Active mode must read
      // head BEFORE the bootstrap data fetch (read-before-stamp rule) so
      // the race falls on the duplicate side, never the gap side.
      const { head } = await syncService.catchUp(this.workspaceId, { after: "0", limit: 1 }, signal)
      if (this.isDestroyed) return
      cursorStore.advance(head)
      console.info("Sync-v2 shadow cursor seeded from head", { workspaceId: this.workspaceId, trigger, head })
      return
    }

    let cursor = cursorBefore
    let head = cursorBefore
    let pages = 0
    let fetched = 0
    const byEventType: Record<string, number> = {}

    while (pages < MAX_SHADOW_CATCHUP_PAGES) {
      const response = await syncService.catchUp(
        this.workspaceId,
        { after: cursor, limit: SHADOW_CATCHUP_PAGE_LIMIT },
        signal
      )
      if (this.isDestroyed) return
      head = response.head
      if (response.entries.length === 0) break

      pages += 1
      fetched += response.entries.length
      for (const entry of response.entries) {
        byEventType[entry.eventType] = (byEventType[entry.eventType] ?? 0) + 1
      }
      // Shadow advances by fetched entries — "applied" is a no-op here. The
      // live onAny path may concurrently advance past this; monotonic max
      // makes the race converge.
      cursor = response.entries[response.entries.length - 1].syncId
      cursorStore.advance(cursor)
    }

    if (fetched > 0 || trigger !== "connect") {
      console.info("Sync-v2 shadow catch-up", {
        workspaceId: this.workspaceId,
        trigger,
        cursorBefore,
        cursorAfter: cursor,
        head,
        fetched,
        pages,
        byEventType,
        truncated: pages >= MAX_SHADOW_CATCHUP_PAGES,
      })
    }
  }

  private cleanupSyncCursorTracking(): void {
    if (this.syncCursorCleanup) {
      this.syncCursorCleanup()
      this.syncCursorCleanup = null
    }
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
    this.cleanupSyncCursorTracking()
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
