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
  bootstrapNonRowFieldsEqual,
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
import { applyDraftsBootstrap, type DraftsServiceLike } from "./draft-sync"
import { waitForInitialReveal } from "./reveal-gate"
import { SyncLogCursor } from "./sync-log-cursor"
import { SocketEventGate, type SyncEventSource } from "./socket-event-gate"
import { CatchUpBatch, LiveCommitBatch } from "./catch-up-batch"
import { beginApplyWindow, endApplyWindow } from "@/stores/apply-window"
import { requestStreamEventReadRefresh } from "@/stores/stream-event-read-refresh"
import { getPerfCapture } from "@/lib/perf/capture"
import { SyncStatusStore } from "./sync-status"
import { streamKeys } from "@/hooks/use-streams"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { savedKeys } from "@/hooks/use-saved"
import { scheduledKeys } from "@/hooks/use-scheduled"
import { activityKeys } from "@/hooks/use-activity"
import { conversationKeys } from "@/hooks/use-conversations"
import { isServerStreamId } from "@/lib/stream-ids"
import type { WorkspaceBootstrap } from "@threa/types"

interface SyncEngineDeps {
  workspaceId: string
  syncStatus: SyncStatusStore
  queryClient: QueryClient
  workspaceService: {
    bootstrap: (workspaceId: string, opts?: { fresh?: boolean }) => Promise<WorkspaceBootstrap>
  }
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
  /** Centralized drafts (Stage 3). `list` seeds the bootstrap reconcile on
   *  connect/reconnect (INV-53); `upsert`/`delete` replay the offline draft
   *  push queue. Absent (test deps) → drafts stay local-only. */
  draftsService?: DraftsServiceLike & {
    list: (workspaceId: string) => Promise<{ drafts: import("@threa/types").Draft[] }>
  }
  /** When provided, the engine runs the sync-log cursor: it pages catch-up on
   *  every connect/resume/heartbeat and applies entries through the live
   *  handlers via the event gate. Absent (degenerate test deps) → no cursor,
   *  no gate, full reconnect bootstrap. */
  syncService?: {
    catchUp: (
      workspaceId: string,
      params: { after: string; limit?: number },
      signal?: AbortSignal
    ) => Promise<import("@threa/types").SyncCatchUpResponse>
  }
}

/** Safety valve for catch-up paging (20 pages × 500 entries). */
const MAX_CATCHUP_PAGES = 20
const CATCHUP_PAGE_LIMIT = 500

/** Max in-flight board card stream catch-ups. Bounds the bootstrap-fetch burst
 *  when the board opens onto many unsynced thread/public streams at once. */
const BOARD_SYNC_CONCURRENCY = 6

/**
 * Above this many missed entries on the first catch-up page, heal the whole
 * workspace with one atomic snapshot instead of replaying the gap entry by
 * entry. Replay drives the live handlers per entry — each missed stream, draft,
 * membership and read advances its own cache + IDB write and re-renders the
 * sidebar/badges alone — so a long offline window (a laptop asleep for days)
 * visibly trickles streams in, archives them, flips unread counts and flies
 * drafts in and out one at a time over many seconds. The forced full bootstrap
 * applies the entire workspace in a single settle (one IDB transaction + one
 * `setQueryData`), so a large gap lands at its final state at once.
 *
 * Tuned to separate a brief blip (a handful of entries — cheap to replay, no
 * extra full-snapshot fetch) from a real catch-up. A page at or below
 * `CATCHUP_PAGE_LIMIT` keeps the existing per-entry replay (with counters and
 * previews still coalesced by the catch-up batch).
 */
export const CATCHUP_COLLAPSE_THRESHOLD = 200

/**
 * How long a heartbeat-detected lag must persist before it triggers catch-up.
 * The server reads the head from the log and sequence-before-emit means the
 * matching emits can still be in flight when the heartbeat lands — during
 * live traffic nearly every tick would otherwise pause the gate for a gap
 * that closes itself. The re-check after this window only fetches if the
 * client is still behind.
 */
const HEARTBEAT_GRACE_MS = 2_000

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
  /** Whether the queued reconnect bootstrap must run as a full snapshot. A
   *  below-floor `forceFull` request arriving while a slim reconnect is already
   *  queued upgrades the queued run rather than being collapsed away. */
  private queuedReconnectForceFull = false
  private activeStreamRefreshes = new Map<string, Promise<void>>()
  /** Single-flighted display-only HTTP warm fetches (see warmStreamOverHttp).
   *  Kept separate from activeStreamRefreshes: a warm fetch performs no room
   *  join, so it must never satisfy a reconnect-path refresh that needs one. */
  private activeWarmFetches = new Map<string, Promise<void>>()
  private activeGapBackfills = new Map<string, { cursor: string; promise: Promise<void> }>()
  /** Lowest gap cursor reported per stream while a backfill was in flight —
   *  drained into one follow-up backfill when the active one settles. */
  private queuedGapCursors = new Map<string, string>()
  private hasEverConnected = false
  /**
   * False until this session's cold-boot workspace snapshot has been applied
   * (or definitively failed). While it is false a snapshot is still pending
   * that will stamp the sync cursor from its own `syncHead`, so nothing may
   * seed the cursor from a separately-read network head — `advance` is a
   * monotonic max, so the higher network head would win and silently mask the
   * snapshot's, stranding every entry between the two. The service worker can
   * answer that bootstrap with a copy captured when the tab last hid, which is
   * exactly when the two heads diverge.
   */
  private coldSnapshotSettled = false
  /** Whether the engine has been destroyed. Public for ref-check re-creation. */
  isDestroyed = false

  // Sync-engine cursor: one lastSyncId per workspace. Catch-up entries are
  // applied through the live handlers via the event gate, while live events
  // buffer-and-splice around each catch-up window. Present iff syncService is
  // wired. See sync-log-cursor.ts.
  private readonly eventGate: SocketEventGate | null
  private syncLogCursor: SyncLogCursor | null = null
  private activeCatchUp: Promise<void> | null = null
  private catchUpAbort: AbortController | null = null
  /** Bumped on every gate pause (connect/resume trigger). A catch-up run
   *  belongs to the cycle it started in; a stale run must not reopen the
   *  gate for a newer cycle's bootstrap window. */
  private catchUpCycle = 0
  private activeCatchUpCycle = 0
  private queuedCatchUp: Promise<void> | null = null
  /** Set for the duration of a catch-up replay so the counter/preview handlers
   *  fold into it instead of writing per-entry; flushed once when the window
   *  closes (see performActiveCatchUp). Null → live, write-immediately. */
  private activeCatchUpBatch: CatchUpBatch | null = null
  /** Coalesces one task's live counter/preview writes into one transaction and
   *  one cache publication (feature-gated in the handler seams). Flushed before
   *  a catch-up window opens so a live fold never interleaves into a replay
   *  fold, and destroyed with the engine so a scheduled flush can't write
   *  against a torn-down workspace. */
  private readonly liveCommitBatch: LiveCommitBatch

  // Heartbeat (active mode): the highest workspace head observed in catch-up
  // responses. The cursor is per-user filtered and can sit permanently below
  // the workspace-global head, so heartbeat comparisons run against
  // max(cursor, lastSeenHead) — an empty catch-up page proves nothing visible
  // exists in (cursor, head], without ever moving the cursor toward head.
  private lastSeenHead: bigint | null = null
  private heartbeatGraceTimer: ReturnType<typeof setTimeout> | null = null
  /** Max behind-head among heartbeats received while the grace timer is armed. */
  private pendingHeartbeatHead: bigint | null = null
  private heartbeatCleanup: (() => void) | null = null
  private operationQueueRetryTimer: ReturnType<typeof setTimeout> | null = null

  // Ref-like state updated by the React layer
  private currentStreamId: string | undefined = undefined
  /** URL-visible stream surfaces: the route stream plus bare-stream panels. */
  private visibleStreamIds: string[] = []
  /** Streams whose board cards are on screen — declared by the board page, kept
   *  separate from `visibleStreamIds` (which is replaced wholesale). Their
   *  bodies ride `db.events`, so the board joins + catches them up like any opened
   *  stream and re-asserts them across reconnects (see setBoardStreamIds). */
  private boardStreamIds = new Set<string>()
  /** Streams an open conversation panel (Mechanism B) reads — its conversation's
   *  root + threads. Kept in its own slot, NOT folded into boardStreamIds, so the
   *  panel and the board feed each own their declaration: a panel open over the
   *  board page mustn't clobber the feed's larger set (both would otherwise race
   *  the single board slot). Same lifecycle as board streams — caught up + joined
   *  here, re-asserted across reconnects, never torn down per-card. */
  private panelStreamIds = new Set<string>()
  private currentUser: { id: string } | null = null
  /** Last workspace bootstrap error, if any. Consumers can check this for 404/403 handling. */
  lastWorkspaceError: unknown = null

  readonly workspaceId: string

  constructor(private deps: SyncEngineDeps) {
    this.workspaceId = deps.workspaceId
    this.liveCommitBatch = new LiveCommitBatch(deps.queryClient, deps.workspaceId, () => {
      // Same recovery the catch-up flush failure takes: a dropped fold can hold
      // an `activity:created` held-set insert, which no later message re-adds,
      // and a slim reconnect does NOT re-fetch the workspace counters.
      if (!this.isDestroyed) void this.runBootstrap(true, { forceFull: true })
    })
    this.eventGate = deps.syncService
      ? new SocketEventGate(this.workspaceId, {
          onApplied: (syncId) => this.syncLogCursor?.advance(syncId),
        })
      : null
  }

  /** Update the current stream ID (called from React when route changes). */
  setCurrentStreamId(id: string | undefined): void {
    if (this.currentStreamId === id) return
    this.currentStreamId = id
    if (id) {
      void this.refreshStreamAfterNavigation(id)
    }
  }

  /**
   * Refresh newly visible route/panel streams. A cached bootstrap has infinite
   * stale time, so the query observer alone will not close events missed while
   * a panel was hidden; the engine-owned delta does (INV-53).
   */
  setVisibleStreamIds(ids: string[]): void {
    const previous = new Set(this.visibleStreamIds)
    this.visibleStreamIds = ids

    for (const streamId of ids) {
      if (previous.has(streamId) || !isServerStreamId(streamId)) continue
      void this.refreshStreamAfterNavigation(streamId)
    }
  }

  /**
   * Declare the streams whose board cards are currently on screen. The board
   * renders message bodies OFFLINE-FIRST off the `db.events` rail, so a card is
   * only fully live + reactive once its stream's history is in IDB and its room
   * is joined — which is exactly what opening the stream does. This drives that
   * for every board card, including threads and public channels the viewer never
   * joined (member streams are already subscribed at bootstrap).
   *
   * It is additive and must NEVER route through setVisibleStreamIds — that set is
   * URL-derived and replaced wholesale (clobbering it would drop the open
   * route/panel reconnect catch-up). Newly-declared streams are caught up +
   * bootstrapped here unless their history is already local (syncBoardStreams'
   * persisted-window skip), concurrency-capped so opening the board doesn't fire
   * a fetch burst across dozens of unsynced streams. Board streams join the
   * reconnect / connectivity-resume re-sync set (getVisibleServerStreamIds) so
   * they stay live across drops while the board is open.
   *
   * Subscriptions are NOT torn down per card: clearing on unmount only shrinks the
   * reconnect set (so a closed board doesn't re-fetch on reconnect), while the
   * persisted-window skip means reopening the board costs one IDB probe per
   * stream and no network. We never unsubscribe a board stream — that would race
   * a card click that navigates into the very stream being torn down.
   */
  setBoardStreamIds(ids: string[]): void {
    const next = new Set(ids)
    const toSync: string[] = []
    for (const streamId of next) {
      if (this.boardStreamIds.has(streamId) || !isServerStreamId(streamId)) continue
      toSync.push(streamId)
    }
    this.boardStreamIds = next
    // Newly-declared streams INCLUDING already-subscribed ones: a bootstrap room
    // join is not history, so `syncBoardStreams` decides per stream whether a
    // fetch is actually needed (see its persisted-window skip).
    if (toSync.length > 0) void this.syncBoardStreams(toSync)
  }

  /**
   * Declare the streams an open conversation panel reads (its conversation's root
   * + threads). Same mechanics as {@link setBoardStreamIds} but on its own slot,
   * so it composes with the board feed instead of clobbering it. Newly-declared
   * unsubscribed streams are caught up + joined; the set is re-asserted across
   * reconnects via getVisibleServerStreamIds.
   */
  setPanelStreamIds(ids: string[]): void {
    const next = new Set(ids)
    const toSync: string[] = []
    for (const streamId of next) {
      if (this.panelStreamIds.has(streamId) || !isServerStreamId(streamId)) continue
      toSync.push(streamId)
    }
    this.panelStreamIds = next
    if (toSync.length > 0) void this.syncBoardStreams(toSync)
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
    // Synchronously, before any await: events arriving right after the
    // connect ack must already flow through the gate's forwarders — and be
    // buffered, not applied. Pausing here (not at catch-up start) is what
    // keeps the catch-up position honest: an applied live event advances the
    // cursor optimistically, and a cursor that jumps during the bootstrap
    // window would make catch-up skip the very disconnect gap it heals.
    // This cycle's catch-up run reopens live flow when it completes.
    this.eventGate?.attach(socket)
    this.beginCatchUpCycle()

    if (isReconnect) {
      this.deps.syncStatus.setAllStale()
      this.cleanupWorkspaceHandlers()
      this.cleanupStreamHandlers()
    }

    if (this.eventGate) {
      this.trackHeartbeat(socket)
      // Read-before-stamp: the cursor must never end up above the snapshot the
      // bootstrap applies, so any race falls on the duplicate side (entry also
      // present in the snapshot — idempotent) rather than the gap side (entry
      // stamped below the position — permanent loss).
      //
      // A reconnect satisfies that by reading head here, before the fetch. A
      // cold boot cannot: the service worker may answer its bootstrap with a
      // snapshot captured before this device went away, so a head read here
      // would sit above it. It takes the guarantee from the snapshot's own
      // server-read `syncHead` instead — the one party that can pair a head
      // with the snapshot it hands back — and this call leaves the position
      // unset until then (see `coldSnapshotSettled`).
      await this.initializeActiveCursor()
      if (this.isDestroyed) return
    }

    // Resume persisted background uploads for this workspace (reload/PWA
    // reopen). Fire-and-forget and idempotent per session — reconnects no-op.
    void import("@/lib/uploads/upload-manager").then(({ resumeWorkspaceUploads }) =>
      resumeWorkspaceUploads(this.deps.workspaceId)
    )

    // Register workspace-level socket handlers (stream:created, stream:updated, etc.)
    this.workspaceHandlerCleanup = registerWorkspaceSocketHandlers(
      this.liveEventSource(socket),
      this.deps.workspaceId,
      this.deps.queryClient,
      {
        getCurrentStreamId: () => this.currentStreamId,
        getCurrentUser: () => this.currentUser,
        subscribeStream: (streamId: string) => void this.subscribeStream(streamId),
        getCatchUpBatch: () => this.activeCatchUpBatch,
        getLiveCommitBatch: () => this.liveCommitBatch,
      }
    )

    await this.runBootstrap(isReconnect)

    // A reconnect catches up the visible + board streams inside runBootstrap (via
    // getVisibleServerStreamIds); a first connect deliberately does not. But the
    // board may already be mounted from cache (a deep-link or warm-but-offline
    // open that just came online), so sync any declared board streams whose rooms
    // the fresh bootstrap didn't join — otherwise their cards wouldn't go live
    // until the next reconnect.
    if (!isReconnect && (this.boardStreamIds.size > 0 || this.panelStreamIds.size > 0)) {
      // Subscribed streams stay in the set: bootstrap just joined every member
      // stream's room (subscribeMemberStreams), but a fresh device has no
      // history for them — syncBoardStreams' persisted-window skip separates
      // the two, so warm streams cost one IDB probe and cold ones backfill.
      const pending = [...this.boardStreamIds, ...this.panelStreamIds].filter(isServerStreamId)
      if (pending.length > 0) void this.syncBoardStreams([...new Set(pending)])
    }

    // Process pending offline operations (edits, deletes, reactions, drafts)
    this.kickOperationQueue()

    // Pull + reconcile the author's drafts (INV-53), paired with the user-room
    // subscription and re-run on reconnect. Fire-and-forget so the network pull
    // never blocks the connect path — drafts are local-first.
    void this.syncDrafts()

    // Runs after bootstrap so it never competes for the connection setup
    // window. Applies entries through the gate (no-op without a sync service).
    void this.runCatchUp(isReconnect ? "reconnect" : "connect")
  }

  /**
   * Rehydrate visible streams after a connectivity gap even if Socket.IO did
   * not emit a full reconnect cycle (for example, brief offline gaps where the
   * transport survives but the client missed stream updates).
   */
  async refreshAfterConnectivityResume(): Promise<void> {
    if (this.isDestroyed) return
    // Same pause-before-bootstrap rule as onConnect: the catch-up position
    // must not move between this trigger and the catch-up fetch.
    this.beginCatchUpCycle()
    // Resume is a reconnect-shaped trigger: when the cursor is active the slim
    // path (per-stream deltas for visible streams) plus the catch-up replay
    // below re-seeds every workspace-scoped projection, so a full snapshot
    // refetch would only duplicate what catch-up already heals. No-syncService
    // deps and the first connect fall through to
    // the full snapshot inside runBootstrap; the below-floor catch-up fallback
    // re-forces full when the cursor has dropped beneath the retained
    // sync-log floor.
    await this.runBootstrap(true)
    void this.runCatchUp("resume")
  }

  async refreshVisibleEventReads(): Promise<void> {
    if (this.isDestroyed) return
    try {
      await requestStreamEventReadRefresh(this.getVisibleServerStreamIds())
    } catch (error) {
      console.error("Stream event read refresh failed", { workspaceId: this.workspaceId, error })
    }
  }

  /**
   * Called when the page resumes from a long hidden period (e.g. phone
   * unlocked after app-switch). Probes the socket for liveness; if the
   * probe fails, forces a reconnect to short-circuit socket.io's 20–25s
   * native zombie detection. If the probe succeeds, refreshes state since
   * events may have been missed while the page was backgrounded.
   */
  async handlePageResume(): Promise<void> {
    if (this.isDestroyed) return
    // A service worker can write the pushed message into IDB while Android has
    // frozen the page, so Dexie's live query misses the cross-context wake-up.
    // Re-read mounted event windows even when the HTTP delta below is empty
    // because its cursor already sees that service-worker write.
    void this.refreshVisibleEventReads()
    if (!this.socket || !this.hasEverConnected) return
    // Warm the open stream over plain HTTP before anything socket-shaped runs.
    // The socket is the slowest thing on a phone resume — a zombie transport
    // takes a ping timeout to detect and seconds more to reconnect and rejoin
    // rooms — while an HTTP delta needs one round trip. This is what puts the
    // message the user is coming back for on screen; the socket paths below
    // remain the correctness authority and re-refresh behind it.
    if (this.currentStreamId) void this.warmStreamOverHttp(this.currentStreamId)
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
      getPerfCapture().mark("stream.subscriptions", this.streamHandlerCleanups.size)
    }
  }

  /**
   * Kick the offline operation queue (edits, deletes, reactions).
   * Called on connect and can be called after enqueueOperation.
   */
  kickOperationQueue(): void {
    if (!this.deps.messageService) return
    if (this.operationQueueRetryTimer) {
      clearTimeout(this.operationQueueRetryTimer)
      this.operationQueueRetryTimer = null
    }
    void processOperationQueue(
      this.deps.messageService,
      this.deps.reactionService ?? { add: async () => {}, remove: async () => {} },
      this.deps.scheduledService,
      this.deps.draftsService,
      () => this.socket !== null && !this.isDestroyed
    ).then((retryAt) => {
      if (retryAt === null || this.isDestroyed || !this.socket) return
      if (this.operationQueueRetryTimer) clearTimeout(this.operationQueueRetryTimer)
      const delay = Math.max(0, retryAt - Date.now())
      this.operationQueueRetryTimer = setTimeout(() => {
        this.operationQueueRetryTimer = null
        this.kickOperationQueue()
      }, delay)
    })
  }

  /**
   * Bootstrap-and-reconcile the author's drafts against the server (INV-53):
   * paired with the existing `user:{userId}` socket subscription and re-run on
   * every (re)connect to close the disconnect gap. Reconcile may enqueue pushes
   * for never-synced local drafts, so we kick the queue afterwards. Failures are
   * swallowed — drafts are local-first, so a failed pull never blocks the app.
   */
  private async syncDrafts(): Promise<void> {
    const draftsService = this.deps.draftsService
    if (!draftsService) return
    try {
      const { drafts } = await draftsService.list(this.deps.workspaceId)
      if (this.isDestroyed) return
      await applyDraftsBootstrap(this.deps.workspaceId, drafts)
      this.kickOperationQueue()
    } catch {
      // Local copy stands; the next (re)connect retries the pull.
    }
  }

  /** Current sync-log cursor (v2), or null when none is tracked yet. */
  getSyncCursor(): string | null {
    return this.syncLogCursor?.get() ?? null
  }

  /**
   * Registration surface for live stream handlers mounted outside the engine
   * (useStreamSocket). In active mode this is the event gate, so hook-mounted
   * handlers participate in catch-up dispatch and buffer-and-splice exactly
   * like engine-owned ones; otherwise callers fall back to the raw socket.
   */
  getLiveEventSource(): SyncEventSource | null {
    return this.eventGate
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
        const fetchStartedAt = Date.now()
        const bootstrap = await streamService.bootstrap(workspaceId, streamId, { after: afterSequence })
        if (this.isDestroyed) return
        await applyStreamBootstrap(workspaceId, streamId, bootstrap, { fetchStartedAt, queryClient })
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
    this.liveCommitBatch.destroy()
    this.cleanupAllHandlers()
    this.subscribedStreams.clear()
    if (this.operationQueueRetryTimer) clearTimeout(this.operationQueueRetryTimer)
    this.operationQueueRetryTimer = null
    this.socket = null
    // Dispose without flushing or splicing — destroy can be an account switch
    // that repoints the shared db proxy, and neither the cursor nor buffered
    // events may leak across accounts. See SyncLogCursor / SocketEventGate.
    this.catchUpAbort?.abort()
    this.catchUpAbort = null
    this.eventGate?.dispose()
    this.syncLogCursor?.dispose()
    this.syncLogCursor = null
  }

  // =========================================================================
  // Internal
  // =========================================================================

  private async bootstrapWorkspace(_isReconnect: boolean, forceFull = false): Promise<void> {
    // Reconnect slimming: catch-up replay (which runs right after this)
    // re-seeds every workspace-scoped projection through the gate-registered
    // handlers, so re-fetching the full workspace snapshot on every reconnect
    // is redundant. Skip it and instead do only what catch-up can't: the
    // per-stream message deltas (the per-stream cursor mechanism, unchanged).
    // `forceFull` (below-floor fallback) and the first connect / no-syncService
    // cases keep the full snapshot. `eventGate` is present iff a sync service is
    // wired, so it stands in for "catch-up will run".
    if (_isReconnect && !forceFull && this.eventGate) {
      await this.slimReconnectBootstrap()
      return
    }

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
          workspaceService.bootstrap(workspaceId, { fresh: true }),
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
        // IDB supplies the cached paint. A cached HTTP snapshot can predate both
        // that local state and its cursor, so applying it can undo already-synced work.
        const stopFetch = getPerfCapture().time("bootstrap.fetch")
        bootstrap = await workspaceService.bootstrap(workspaceId, { fresh: true })
        stopFetch()

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

        // Write to IDB (source of truth); the returned bootstrap carries the
        // per-stream-merged counter fields so the cache write below matches IDB.
        const applied = await applyWorkspaceBootstrap(workspaceId, bootstrap, fetchStartedAt)
        bootstrap = applied.bootstrap

        // Write to TanStack cache (bridge for coordinated-loading, sidebar loading/error).
        // Functional updater: when the apply wrote no row and every field the row
        // diff can't speak for is unchanged, keep the cached object. Returning
        // `prev` makes TanStack's replaceEqualDeep an identity hit instead of a
        // ~1,000-row walk, and leaves other writers' cache patches intact.
        const stopPublish = getPerfCapture().time("bootstrap.publish")
        const next = bootstrap
        let replaced = false
        queryClient.setQueryData(workspaceKeys.bootstrap(workspaceId), (prev?: WorkspaceBootstrap) => {
          if (!applied.anyChanged && prev && bootstrapNonRowFieldsEqual(prev, next)) return prev
          replaced = true
          return next
        })
        stopPublish()
        if (replaced) getPerfCapture().mark("bootstrap.cachePublish", 1)

        // Cold-boot single bootstrap: this first-connect snapshot is the
        // authority for everything <= its sync head (read-before-stamp on the
        // backend). Jump the cursor there so the catch-up that runs next sees no
        // gap — otherwise a stale cursor persisted from a prior session makes
        // catch-up collapse the gap into a SECOND full bootstrap. Reconnects are
        // excluded: their cursor marks the disconnect window catch-up must heal.
        if (!_isReconnect && this.eventGate && bootstrap.syncHead) {
          this.syncLogCursor?.advance(bootstrap.syncHead)
          this.noteSeenHead(bootstrap.syncHead)
        }
        // Snapshot applied: no pending cold snapshot can be masked any more, so
        // catch-up's fallback seed may read head again from here on.
        if (!_isReconnect) this.coldSnapshotSettled = true
      }

      this.lastWorkspaceError = null
      syncStatus.set(`workspace:${workspaceId}`, "synced")

      // Subscribe all member streams: join rooms + register socket handlers.
      // On reconnect, cleanupStreamHandlers() already cleared the old handlers,
      // so these are fresh registrations.
      await this.subscribeMemberStreams(bootstrap.streamMemberships.map((sm) => sm.streamId))
    } catch (error) {
      this.lastWorkspaceError = error
      // No snapshot landed, so none can be masked: release the seed guard or a
      // failed cold bootstrap would leave the cursor unseedable for the whole
      // session and catch-up would never gain a position.
      if (!_isReconnect) this.coldSnapshotSettled = true
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

  /**
   * The active-mode reconnect bootstrap, minus the full workspace-snapshot
   * fetch + reconcile. Everything here is what workspace catch-up replay can't
   * cover on its own:
   *
   * - Per-stream message deltas for the visible streams. Timeline events ride a
   *   per-stream sequence (INV-61), not the workspace sync-log, so they heal
   *   through `bootstrap?after=` (cursor-before-join), never catch-up. Applying
   *   those events also reconciles the sidebar's agent-session projection.
   * - Re-subscribing member rooms from the cached membership list, so
   *   `stream:activity` keeps flowing onto the sidebar. Membership added/removed
   *   while offline is replayed by catch-up (`stream:member_*` → subscribe).
   *
   * The workspace gate is paused (begun in `onConnect`) for the whole window,
   * so the IDB writes here land before catch-up applies its delta and before
   * buffered live events splice in on top — newest state wins, no regression.
   */
  private async slimReconnectBootstrap(): Promise<void> {
    const { workspaceId, syncStatus } = this.deps
    syncStatus.set(`workspace:${workspaceId}`, "syncing")

    // Mirror the full path's swallow-everything discipline. This runs inside
    // the awaited `runBootstrap` in onConnect; if it rejected, the await would
    // throw and `runCatchUp` — the only path that resumes the paused gate —
    // would never run, stranding every buffered live event. So an unexpected
    // failure (e.g. an IDB read in cachedMemberStreamIds) sets the workspace
    // stale (cached data is already on screen on a reconnect) and returns;
    // catch-up still runs and the next reconnect bootstrap closes the gap.
    try {
      if (this.socket) {
        await joinRoomBestEffort(this.socket, `ws:${workspaceId}`, "SyncEngine")
      }
      if (this.isDestroyed) return

      // Per-stream message deltas: each refresh owns its own status + error
      // handling, and they run in parallel.
      await Promise.all(this.getVisibleServerStreamIds().map((streamId) => this.refreshStreamAfterNavigation(streamId)))
      if (this.isDestroyed) return

      await this.subscribeMemberStreams(await this.cachedMemberStreamIds())
      if (this.isDestroyed) return

      this.lastWorkspaceError = null
      syncStatus.set(`workspace:${workspaceId}`, "synced")
    } catch (error) {
      this.lastWorkspaceError = error
      syncStatus.set(`workspace:${workspaceId}`, "stale")
    }
  }

  /**
   * @param forceFull Run the full workspace-snapshot bootstrap even on an
   *   active-mode reconnect (where it would otherwise be slimmed to per-stream
   *   deltas). The below-floor catch-up fallback sets this:
   *   a cursor below the retained sync-log floor has no log to replay, so only
   *   the full snapshot is authoritative for everything `<= head`.
   */
  private runBootstrap(isReconnect: boolean, opts?: { forceFull?: boolean }): Promise<void> {
    const forceFull = opts?.forceFull ?? false
    if (this.activeBootstrap) {
      // If a reconnect arrives while a non-reconnect bootstrap (e.g.
      // retryWorkspace) is in flight, we can't mutate the in-flight request
      // to upgrade its semantics — it already chose visibleStreamIds=[] and
      // won't do the per-stream delta fetch. Chain a follow-up reconnect
      // bootstrap so the visible streams get their delta fetch once the
      // current bootstrap finishes. Repeat reconnect triggers collapse onto
      // the same queued promise.
      if (isReconnect) {
        // forceFull is a strictly stronger request than a slim reconnect, so it
        // must survive collapsing onto an already-queued reconnect: the chain
        // reads this flag at execution time rather than capturing `forceFull`,
        // so a below-floor forceFull arriving after a slim reconnect is queued
        // upgrades the single queued run to a full snapshot.
        if (forceFull) this.queuedReconnectForceFull = true
        if (!this.queuedReconnectBootstrap) {
          const chained = this.activeBootstrap
            .catch(() => {
              // Swallow — the follow-up reconnect will retry whatever failed.
            })
            .then(() => {
              const queuedForceFull = this.queuedReconnectForceFull
              this.queuedReconnectBootstrap = null
              this.queuedReconnectForceFull = false
              return this.runBootstrap(true, { forceFull: queuedForceFull })
            })
          this.queuedReconnectBootstrap = chained
        }
      }
      return this.queuedReconnectBootstrap ?? this.activeBootstrap
    }

    const bootstrapPromise = this.bootstrapWorkspace(isReconnect, forceFull).finally(() => {
      if (this.activeBootstrap === bootstrapPromise) {
        this.activeBootstrap = null
      }
    })

    this.activeBootstrap = bootstrapPromise
    return bootstrapPromise
  }

  private getVisibleServerStreamIds(): string[] {
    const streamIds = [
      ...(this.currentStreamId ? [this.currentStreamId] : []),
      ...this.visibleStreamIds,
      ...this.boardStreamIds,
      ...this.panelStreamIds,
    ]
    return Array.from(new Set(streamIds.filter(isServerStreamId)))
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

  /**
   * Full catch-up + bootstrap for board card streams, in feed order (the viewer
   * sees the top first) and bounded to BOARD_SYNC_CONCURRENCY in-flight so a
   * board open across dozens of unsynced streams doesn't saturate the network on
   * a spotty connection. Reuses refreshStreamAfterNavigation — the same
   * cursor-before-join → bootstrap → applyStreamBootstrap path opening a stream
   * runs — which dedupes in-flight refreshes and, while the socket is down,
   * degrades to the display-only HTTP warm fetch (delta-only, so cards with no
   * persisted window skip instead of fetching).
   */
  private async syncBoardStreams(streamIds: string[]): Promise<void> {
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < streamIds.length && !this.isDestroyed) {
        const streamId = streamIds[cursor++]
        // "Subscribed" means the room is joined, not that history is local:
        // subscribeMemberStreams joins every member stream at bootstrap, so on
        // a fresh device a member stream is subscribed with an EMPTY events
        // store — skipping it here left board branch groups bodiless ("N more
        // replies") until the stream was opened. Skip only when a persisted
        // window exists; the room join plus the workspace catch-up cursor keep
        // that window current, so re-fetching it would be redundant network.
        // Reading the sequence as an emptiness probe is safe outside
        // joinStreamForCatchUp's cursor-before-join rule: nothing is ordered
        // against a join, and the refresh below re-derives its own cursor.
        if (this.subscribedStreams.has(streamId) && (await getLatestPersistedSequence(streamId)) !== null) continue
        await this.refreshStreamAfterNavigation(streamId)
      }
    }
    const lanes = Math.min(BOARD_SYNC_CONCURRENCY, streamIds.length)
    await Promise.all(Array.from({ length: lanes }, () => worker()))
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
   * against a room join themselves. The two other sanctioned readers are
   * `backfillStreamGap`, which intentionally uses an explicit PRE-GAP cursor
   * (the current latest would skip the very hole it fills), and
   * `performHttpWarmFetch`, which pairs the read with NO join at all — a
   * display-only fetch outside the subscribe→fetch window this rule guards.
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
        this.liveEventSource(this.socket),
        this.deps.workspaceId,
        streamId,
        this.deps.queryClient,
        {
          onSequenceGap: ({ streamId: gapStreamId, afterSequence }) =>
            void this.backfillStreamGap(gapStreamId, afterSequence),
        }
      )
      this.streamHandlerCleanups.set(streamId, cleanup)
      getPerfCapture().mark("stream.subscriptions", this.streamHandlerCleanups.size)
    }

    const room = `ws:${this.deps.workspaceId}:stream:${streamId}`
    if (options?.awaitJoin) {
      await joinRoomBestEffort(this.socket, room, "SyncEngine")
      return
    }

    joinRoomFireAndForget(this.socket, room, new AbortController().signal, "SyncEngine")
  }

  private refreshStreamAfterNavigation(streamId: string): Promise<void> {
    if (this.isDestroyed || !isServerStreamId(streamId)) {
      return Promise.resolve()
    }

    // Socket down (backgrounded transport, reconnect in flight): don't skip
    // freshness entirely — HTTP can succeed while the socket can't. Warm the
    // window now; the reconnect's slim bootstrap re-runs the cursor-owned
    // refresh (with the room join) once the socket is back.
    if (!this.socket || !this.socket.connected) {
      return this.warmStreamOverHttp(streamId)
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

      const fetchStartedAt = Date.now()
      const bootstrap = await streamService.bootstrap(workspaceId, streamId, after ? { after } : undefined)
      await applyStreamBootstrap(workspaceId, streamId, bootstrap, { fetchStartedAt, queryClient })

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

  /**
   * Display-only warm fetch: pull the stream's bootstrap delta (`after` = the
   * latest persisted sequence) over plain HTTP and merge it into IDB, without
   * waiting for the socket. No-op for streams with no persisted window.
   *
   * This deliberately performs NO room join and therefore sits outside the
   * cursor-before-join discipline of joinStreamForCatchUp: nothing here
   * advances a catch-up cursor or opens a live subscription, so a gap between
   * this fetch and the eventual join is impossible — the socket-gated refresh
   * that follows re-derives its own cursor and covers everything after this
   * fetch's window. Overlap is safe (applyStreamBootstrap merges and dedupes
   * by event id). It also stays out of SyncStatusStore: it is a speculative
   * warm-up, not the sync authority, and must not flash loading chrome.
   */
  private warmStreamOverHttp(streamId: string): Promise<void> {
    if (this.isDestroyed || !isServerStreamId(streamId)) {
      return Promise.resolve()
    }

    const existing = this.activeWarmFetches.get(streamId)
    if (existing) return existing

    const warm = this.performHttpWarmFetch(streamId).finally(() => {
      if (this.activeWarmFetches.get(streamId) === warm) {
        this.activeWarmFetches.delete(streamId)
      }
    })
    this.activeWarmFetches.set(streamId, warm)
    return warm
  }

  private async performHttpWarmFetch(streamId: string): Promise<void> {
    const { workspaceId, streamService, queryClient } = this.deps

    try {
      // Delta-only: no persisted window means a fresh open, and fresh opens
      // belong to the bootstrap query layer (useStreamBootstrap / the
      // coordinated stream queries) — warming here too would double-fetch the
      // full window on every cold open.
      const after = await getLatestPersistedSequence(streamId)
      if (after === null || this.isDestroyed) return

      const fetchStartedAt = Date.now()
      const bootstrap = await streamService.bootstrap(workspaceId, streamId, { after })
      if (this.isDestroyed) return
      await applyStreamBootstrap(workspaceId, streamId, bootstrap, { fetchStartedAt, queryClient })

      // Merge into the query-cache bridge ONLY when an entry already exists —
      // same guard as backfillStreamGap. Seeding an append-mode delta as the
      // entry would freeze it as the stream's bootstrap (staleTime: Infinity,
      // no refetch triggers), truncating the display floor to the delta and
      // suppressing the query layer's full-window fetch for the session.
      const queryKey = streamKeys.bootstrap(workspaceId, streamId)
      queryClient.setQueryData<CachedStreamBootstrap>(queryKey, (currentBootstrap) =>
        currentBootstrap
          ? toCachedStreamBootstrap(bootstrap, currentBootstrap, {
              incrementWindowVersionOnReplace: bootstrap.syncMode === "replace",
            })
          : currentBootstrap
      )
    } catch {
      // Speculative warm-up only — the socket-gated refresh path owns errors,
      // retries, and terminal 403/404 handling.
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

  /** Handler registration target: the gate when the cursor is active, else the
   *  raw socket (degenerate no-syncService deps). */
  private liveEventSource(socket: Socket): SyncEventSource {
    return this.eventGate ?? socket
  }

  /**
   * Active-mode heartbeat listener, on the RAW socket — the payload carries
   * no syncId, is not an applied event, and must keep flowing while the gate
   * is paused. The server broadcasts each workspace's sync-log head every
   * SYNC_HEARTBEAT_INTERVAL_MS (see SyncHeartbeatWorker); a head beyond
   * max(cursor, lastSeenHead) means events exist that this client neither
   * applied live nor saw in a catch-up — a dropped emit, caught without
   * waiting for a reconnect/resume trigger.
   */
  private trackHeartbeat(socket: Socket): void {
    this.cleanupHeartbeatTracking()
    const listener = (payload: { workspaceId?: unknown; head?: unknown } | undefined) => {
      this.handleHeartbeat(payload)
    }
    socket.on("sync:heartbeat", listener)
    this.heartbeatCleanup = () => socket.off("sync:heartbeat", listener)
  }

  private handleHeartbeat(payload: { workspaceId?: unknown; head?: unknown } | undefined): void {
    if (this.isDestroyed) return
    if (!payload || payload.workspaceId !== this.workspaceId || typeof payload.head !== "string") return
    const head = parseHeartbeatHead(payload.head)
    if (head === null) return
    // No cursor yet: the connect-time seed/catch-up owns this window.
    const position = this.heartbeatPosition()
    if (position === null || head <= position) return

    if (this.pendingHeartbeatHead === null || head > this.pendingHeartbeatHead) {
      this.pendingHeartbeatHead = head
    }
    // One grace window at a time; repeat heartbeats coalesce onto it via the
    // pending max above.
    this.heartbeatGraceTimer ??= setTimeout(() => {
      this.heartbeatGraceTimer = null
      const pending = this.pendingHeartbeatHead
      this.pendingHeartbeatHead = null
      if (pending === null || this.isDestroyed) return
      const current = this.heartbeatPosition()
      // The gap closed during the grace window — in-flight delivery, not a
      // dropped emit.
      if (current !== null && pending <= current) return
      // Same pause-before-catch-up rule as connect/resume: catch-up applies
      // through the gate, and live events must buffer (then splice) so an
      // older log entry can never regress a newer live LWW payload.
      this.beginCatchUpCycle()
      void this.runCatchUp("heartbeat")
    }, HEARTBEAT_GRACE_MS)
  }

  /** Comparison baseline for heartbeats; null until the cursor is seeded. */
  private heartbeatPosition(): bigint | null {
    const cursor = this.syncLogCursor?.get()
    if (cursor == null) return null
    const cursorValue = BigInt(cursor)
    return this.lastSeenHead !== null && this.lastSeenHead > cursorValue ? this.lastSeenHead : cursorValue
  }

  /** Max-merge a catch-up response's head into the heartbeat baseline. */
  private noteSeenHead(head: string): void {
    const value = parseHeartbeatHead(head)
    if (value === null) return
    if (this.lastSeenHead === null || value > this.lastSeenHead) {
      this.lastSeenHead = value
    }
  }

  private cleanupHeartbeatTracking(): void {
    if (this.heartbeatCleanup) {
      this.heartbeatCleanup()
      this.heartbeatCleanup = null
    }
    if (this.heartbeatGraceTimer) {
      clearTimeout(this.heartbeatGraceTimer)
      this.heartbeatGraceTimer = null
    }
    this.pendingHeartbeatHead = null
  }

  /** Active mode: pause the gate and open a new catch-up cycle. Each
   *  connect/resume trigger gets its own cycle so a catch-up run that was
   *  already in flight cannot reopen live delivery inside the new trigger's
   *  bootstrap window (its finally checks the cycle before resuming). */
  private beginCatchUpCycle(): void {
    if (!this.eventGate) return
    this.eventGate.pause()
    this.catchUpCycle += 1
  }

  /**
   * Active mode, on connect: load the persisted cursor and, when it is unset
   * and no cold snapshot is pending, seed it from head. Errors are non-fatal:
   * catch-up retries seeding later, and the bootstrap healing this phase keeps
   * (INV-53) covers the rare first-run-plus-network-failure gap.
   *
   * While `coldSnapshotSettled` is false this loads the cursor but leaves an
   * unset one unset, because the pending bootstrap stamps it from the
   * snapshot's own `syncHead`. Client-read head and server-stamped snapshot
   * head are only interchangeable while the snapshot is guaranteed to come off
   * the network; the service worker's lock-time bootstrap copy breaks that, and
   * `advance` is a monotonic max, so a head seeded here would win and mask the
   * real one.
   */
  private async initializeActiveCursor(): Promise<void> {
    const cursorStore = (this.syncLogCursor ??= new SyncLogCursor(this.workspaceId))
    try {
      await cursorStore.load()
      if (cursorStore.get() !== null || this.isDestroyed) return
      // A cold snapshot is still pending: leave the position unset so that
      // bootstrap stamps it from the snapshot it actually applied. Every caller
      // funnels through this one guard, so a resume that fires before the first
      // connect, or a reconnect racing the cold bootstrap, cannot seed a head
      // the pending snapshot may predate. See `coldSnapshotSettled`.
      if (!this.coldSnapshotSettled) return
      const abort = (this.catchUpAbort ??= new AbortController())
      const { head } = await this.deps.syncService!.catchUp(this.workspaceId, { after: "0", limit: 1 }, abort.signal)
      if (this.isDestroyed) return
      cursorStore.advance(head)
      this.noteSeenHead(head)
      console.info("Sync cursor seeded from head", { workspaceId: this.workspaceId, head })
    } catch (error) {
      if (this.isDestroyed) return
      console.error("Sync cursor initialization failed", { workspaceId: this.workspaceId, error })
    }
  }

  /**
   * Catch-up after connect/reconnect/resume: pages the sync endpoint from the
   * cursor and applies entries through the gate. Entries fetched here are
   * events the live path never advanced past — after a disconnect that is the
   * healing the cursor owns; on a healthy resume it should be ~zero.
   * Single-flighted; never throws into callers.
   */
  private runCatchUp(trigger: string): Promise<void> {
    if (!this.eventGate || this.isDestroyed) return Promise.resolve()
    if (this.activeCatchUp) {
      // Same cycle: share the in-flight run. An OLDER cycle's run, though,
      // started from a position read before this trigger's gap — its applies
      // are still valid, but it must not stand in for this cycle's healing.
      // Its finally leaves the gate paused (cycle mismatch) and we chain ONE
      // fresh run after it settles, mirroring runBootstrap's queued
      // reconnect chaining (INV-53).
      if (this.activeCatchUpCycle === this.catchUpCycle) return this.activeCatchUp
      this.queuedCatchUp ??= this.activeCatchUp
        .catch(() => {
          // Swallow — the follow-up run retries whatever failed.
        })
        .then(() => {
          this.queuedCatchUp = null
          return this.runCatchUp(trigger)
        })
      return this.queuedCatchUp
    }

    const cycle = this.catchUpCycle
    this.activeCatchUpCycle = cycle
    const abort = new AbortController()
    this.catchUpAbort = abort
    const promise = this.performActiveCatchUp(trigger, abort.signal, cycle)
      .catch((error) => {
        // A destroy-triggered abort is expected teardown, not a failure.
        if (this.isDestroyed) return
        console.error("Sync catch-up failed", {
          workspaceId: this.workspaceId,
          trigger,
          error,
        })
      })
      .finally(() => {
        if (this.activeCatchUp === promise) {
          this.activeCatchUp = null
        }
        if (this.catchUpAbort === abort) {
          this.catchUpAbort = null
        }
      })
    this.activeCatchUp = promise
    return promise
  }

  /**
   * Refresh the surfaces a full-bootstrap collapse does NOT re-derive on its
   * own. Saved and scheduled lists aren't carried by the workspace bootstrap and
   * gate off `refetchOnReconnect` in sync mode (use-saved / use-scheduled), so
   * they are healed only by catch-up replaying their sync-log entries; the
   * activity feed list is likewise handler-invalidated, not bootstrapped; the
   * board's workspace conversation list is seeded by its own query, not the
   * workspace bootstrap. When a
   * large gap (or the below-floor case) collapses to a bootstrap, replay is
   * skipped — without this an already-open Saved / Scheduled / Activity view
   * would sit stale until it remounts (and the board feed would keep last
   * session's cards). Invalidation is a no-op for unmounted
   * queries (they refetch on next mount) and refetches the open ones.
   */
  private invalidateReplayHealedQueries(): void {
    const { queryClient } = this.deps
    queryClient.invalidateQueries({ queryKey: savedKeys.all })
    queryClient.invalidateQueries({ queryKey: scheduledKeys.all })
    queryClient.invalidateQueries({ queryKey: activityKeys.all })
    queryClient.invalidateQueries({ queryKey: conversationKeys.workspaceLists(this.workspaceId) })
  }

  /**
   * Active catch-up: applies log entries through the SAME registered handlers
   * live socket events use (the protocol guarantees `entry.payload` is the
   * exact payload the socket emits — see the sync service doc), in syncId
   * order, awaiting each entry so applies cannot interleave. Duplicates are
   * by design (sweep + dispatcher can both emit; snapshot/log overlap is the
   * safe side of read-before-stamp) and are absorbed by the handlers'
   * idempotency — including the unread counter family, whose absolute
   * payloads max-merge/LWW-set (phase 2c).
   *
   * While catch-up pages, the gate buffers live syncId-bearing events; the
   * finally-splice applies buffered events above the catch-up position and
   * reopens live flow. A buffered ABSOLUTE counter event at or below the
   * position must NOT re-apply: its log copy already applied, and activity
   * counts are LWW — re-applying it after a newer log entry would regress
   * them. The cursor advances only past entries that were handed to handlers,
   * never by jumping to head.
   */
  private async performActiveCatchUp(trigger: string, signal: AbortSignal, cycle: number): Promise<void> {
    const syncService = this.deps.syncService!
    const gate = this.eventGate!
    const cursorStore = (this.syncLogCursor ??= new SyncLogCursor(this.workspaceId))
    // The position everything at or below which this run applied from the
    // log (starting from the cursor, whose coverage the bootstrap snapshot
    // owns). Buffered live events above it splice in after catch-up; null
    // means no position is known and the splice applies everything buffered
    // — live behavior.
    let appliedThrough: bigint | null = null

    // Opened the first time this run applies replayed entries (see
    // beginApplyWindow): holds the reactive read layer steady so the sidebar,
    // badges, memberships and drafts paint the replay's FINAL state once when it
    // closes instead of trickling per entry. Not opened for an empty page or a
    // collapse-to-bootstrap (the snapshot already lands atomically). Closed in
    // the finally, so a throw or early return can never strand it open.
    let applyWindowOpen = false

    // Counter and preview updates replayed below fold into this batch (via the
    // handlers' getCatchUpBatch) instead of writing per-entry, so the
    // unread/activity badges and the activity-sorted sidebar paint the final
    // state once at flush rather than flickering through every replayed entry.
    // runCatchUp single-flights, so at most one batch is active at a time.
    // Drain buffered live commits BEFORE the window opens: a live fold left
    // buffered here would flush inside the replay and land on top of it.
    try {
      await this.liveCommitBatch.flush()
    } catch (error) {
      // Same rule as the catch-up batch flush below: this runs OUTSIDE the try
      // whose finally owns gate.resume, so an escaping rejection would leave the
      // gate paused forever — live delivery stops until a reload. The batch has
      // already logged and reseeded; carry on into the replay.
      console.error("Live commit batch pre-catch-up flush failed", { workspaceId: this.workspaceId, error })
    }

    const catchUpBatch = new CatchUpBatch(this.deps.queryClient, this.workspaceId)
    this.activeCatchUpBatch = catchUpBatch

    const capture = getPerfCapture()
    const stopReplay = capture.time("catchup.replay")

    try {
      await cursorStore.load()
      const cursorBefore = cursorStore.get()
      if (cursorBefore === null) {
        // Normally seeded in initializeActiveCursor before bootstrap;
        // reaching here means that failed (offline first run). Retry the
        // seed so future cycles have a position — but this head is read
        // AFTER the bootstrap snapshot, so it must NOT bound the splice: a
        // buffered live event at or below it is not guaranteed to be in the
        // snapshot (read-before-stamp). appliedThrough stays null and the
        // splice applies everything buffered.
        await this.initializeActiveCursor()
        return
      }

      let cursor = cursorBefore
      appliedThrough = BigInt(cursorBefore)
      let head = cursorBefore
      let pages = 0
      let fetched = 0
      const byEventType: Record<string, number> = {}

      while (pages < MAX_CATCHUP_PAGES) {
        const response = await syncService.catchUp(
          this.workspaceId,
          { after: cursor, limit: CATCHUP_PAGE_LIMIT },
          signal
        )
        if (this.isDestroyed) return
        head = response.head
        if (response.requiresBootstrap) {
          // The cursor is below the workspace's retained sync-log floor:
          // retention pruned the entries this run would replay, so the log
          // can't heal the gap. Jump the cursor to head and re-bootstrap —
          // the workspace snapshot is the authority for everything <= head.
          // Read-before-stamp holds: response.head was read before the
          // bootstrap fired here, so the stamped cursor is a lower bound of
          // the upcoming snapshot (the race falls on the duplicate side). The
          // splice (appliedThrough = head) then drops buffered events <= head,
          // which the snapshot already covers, and applies only those above it.
          console.info("Sync catch-up below retention floor; re-bootstrapping", {
            workspaceId: this.workspaceId,
            trigger,
            cursorBefore,
            head: response.head,
          })
          cursorStore.advance(response.head)
          this.noteSeenHead(response.head)
          appliedThrough = BigInt(response.head)
          // forceFull: the cursor is below the retained floor, so catch-up has
          // no entries to replay — only the full workspace snapshot is
          // authoritative for everything <= head. The slim reconnect path
          // (per-stream deltas only) would leave the rest stale. Await it so the
          // snapshot lands BEFORE the finally's gate.resume splices buffered live
          // events (syncId > head) on top — a fire-and-forget bootstrap could
          // finish after the splice and overwrite (regress) events above head.
          this.invalidateReplayHealedQueries()
          await this.runBootstrap(true, { forceFull: true })
          return
        }
        if (response.entries.length === 0) {
          // ONLY an empty page proves nothing visible exists in (cursor, head]
          // — record the head so the next heartbeat at or below it is
          // known-clean. Recording on a non-empty page would be premature: if
          // a later page's fetch fails mid-drain, an inflated lastSeenHead
          // suppresses the very heartbeat re-trigger that would finish the
          // drain (truncation by MAX_CATCHUP_PAGES is healed the same way).
          this.noteSeenHead(response.head)
          break
        }

        // A large gap heals faster and without the trickle by collapsing to one
        // atomic snapshot rather than replaying every missed entry through the
        // live handlers (see CATCHUP_COLLAPSE_THRESHOLD). Only the FIRST page
        // decides (pages === 0) — once entries have been applied, finish the
        // replay rather than re-fetch and re-apply. The mechanics mirror the
        // below-floor branch exactly: jump the cursor to head (the snapshot owns
        // everything <= head), record the head as seen, bound the resume splice
        // at head, and force a full bootstrap. Read-before-stamp holds — head was
        // read before the bootstrap fires, so the snapshot is a lower bound and
        // the splice drops only buffered events the snapshot already covers. The
        // bootstrap is awaited so its snapshot lands BEFORE the finally's
        // gate.resume splices the buffered events on top — fire-and-forget would
        // let the snapshot finish after the splice and regress events above head.
        if (pages === 0 && response.entries.length >= CATCHUP_COLLAPSE_THRESHOLD) {
          capture.mark("catchup.collapse", response.entries.length)
          console.info("Sync catch-up gap large; collapsing to a full bootstrap", {
            workspaceId: this.workspaceId,
            trigger,
            cursorBefore,
            head: response.head,
            firstPageEntries: response.entries.length,
          })
          cursorStore.advance(response.head)
          this.noteSeenHead(response.head)
          appliedThrough = BigInt(response.head)
          this.invalidateReplayHealedQueries()
          await this.runBootstrap(true, { forceFull: true })
          return
        }

        // Committed to replaying this page (not collapsing): hold the reactive
        // read layer steady for the whole replay so every batched store hook
        // re-reads once on close instead of once per entry. Idempotent — opened
        // on the first applied page and kept open across subsequent pages. MUST
        // stay below the collapse/empty returns above: opening on a collapsed or
        // empty page would freeze the UI and then settle mid-bootstrap.
        if (!applyWindowOpen) {
          beginApplyWindow()
          applyWindowOpen = true
        }

        if (pages === 0) capture.mark("catchup.serialReplay", response.entries.length)
        pages += 1
        fetched += response.entries.length
        for (const entry of response.entries) {
          if (this.isDestroyed) return
          byEventType[entry.eventType] = (byEventType[entry.eventType] ?? 0) + 1
          // Mirror the live wire shape exactly: emits carry the syncId
          // spread onto the outbox payload (see emitToGroups).
          const payload =
            typeof entry.payload === "object" && entry.payload !== null
              ? { ...entry.payload, syncId: entry.syncId }
              : entry.payload
          const stopEntry = capture.time("catchup.entryApply")
          await gate.dispatch(entry.eventType, payload)
          stopEntry()
          cursorStore.advance(entry.syncId)
          appliedThrough = BigInt(entry.syncId)
          cursor = entry.syncId
        }
      }

      if (fetched > 0 || trigger !== "connect") {
        console.info("Sync active catch-up", {
          workspaceId: this.workspaceId,
          trigger,
          cursorBefore,
          cursorAfter: cursor,
          head,
          fetched,
          pages,
          byEventType,
          truncated: pages >= MAX_CATCHUP_PAGES,
        })
      }
    } finally {
      // Commit the coalesced counters + previews once, BEFORE the resume splice,
      // so the badges and sidebar jump straight to the catch-up's final state
      // and the buffered live events spliced next apply on top of it. Skipped on
      // destroy (an account switch repoints the shared db — a post-destroy write
      // could land in the wrong account's IDB). The cursor already advanced per
      // entry, so a crash between the last apply and this flush self-heals from
      // the next bootstrap snapshot (this state is derived, never authoritative).
      if (this.activeCatchUpBatch === catchUpBatch) this.activeCatchUpBatch = null
      if (!this.isDestroyed) {
        try {
          await catchUpBatch.flush()
        } catch (error) {
          // A flush failure (e.g. an IDB error) must never strand the gate: the
          // resume below is the only path that reopens live delivery and drains
          // the buffer. Log, then force a full snapshot reseed — a slim reconnect
          // does NOT re-fetch the workspace counters, so without this the dropped
          // counter/preview state could stay stale until a full bootstrap happens
          // to run. forceFull re-fetches the authoritative snapshot. Fire-and-
          // forget; it owns its own error handling.
          console.error("Sync catch-up batch flush failed", { workspaceId: this.workspaceId, error })
          void this.runBootstrap(true, { forceFull: true })
        }
      }

      // Reopen live flow, even on a failed fetch or early return (the buffer
      // must never strand) — but only when this run still belongs to the
      // CURRENT pause cycle. If a newer connect/resume paused the gate while
      // this run was in flight, its bootstrap window is still open; leave the
      // gate paused and let that cycle's own run (chained by runCatchUp) do
      // the splice. Buffered events at or below the applied position were
      // already applied from the log.
      if (!this.isDestroyed && this.catchUpCycle === cycle) {
        const through = appliedThrough
        await gate.resume((_eventType, syncId) => through === null || syncId > through)
      }

      // Release the held read layer last — after the batch flush AND the resume
      // splice have written — so the one re-read every batched hook does on close
      // reflects the replay's final state plus the spliced live events together.
      // Unconditional (even on destroy/throw) so the window never strands open.
      if (applyWindowOpen) endApplyWindow()
      stopReplay()
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
    getPerfCapture().mark("stream.subscriptions", this.streamHandlerCleanups.size)
    this.subscribedStreams.clear()
  }

  private cleanupAllHandlers(): void {
    this.cleanupWorkspaceHandlers()
    this.cleanupStreamHandlers()
    this.cleanupHeartbeatTracking()
  }
}

/** Wire heads are server-stamped, but tolerate malformed input like the
 *  cursor does (see SyncLogCursor) — a rogue payload must not throw in a
 *  socket listener. */
function parseHeartbeatHead(value: string): bigint | null {
  try {
    return BigInt(value)
  } catch {
    console.warn("Sync: ignoring malformed heartbeat head", { value })
    return null
  }
}

/**
 * Whether `engine` can keep serving this workspace; when false, the React
 * layer destroys it and constructs a fresh one. Only a workspace switch (or a
 * prior destroy) forces recreation now that the cursor mode is fixed — the
 * engine always runs the active cursor when a sync service is wired.
 */
export function isSyncEngineCurrent(engine: SyncEngine, workspaceId: string): boolean {
  return engine.workspaceId === workspaceId && !engine.isDestroyed
}

export const SyncEngineContext = createContext<SyncEngine | null>(null)

export function useSyncEngine(): SyncEngine {
  const engine = useContext(SyncEngineContext)
  if (!engine) throw new Error("useSyncEngine must be used within a SyncEngineContext provider")
  return engine
}

export function useOptionalSyncEngine(): SyncEngine | null {
  return useContext(SyncEngineContext)
}
