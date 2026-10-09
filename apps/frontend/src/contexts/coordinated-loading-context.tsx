import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { usePreloadImages } from "@/hooks/use-preload-images"
import { useCoordinatedStreamQueries } from "@/hooks/use-coordinated-stream-queries"
import { useSealedNamePendingResolver } from "@/hooks/use-decrypted-stream-name"
import {
  hasSeededWorkspaceCache,
  seedCacheFromIdb,
  useWorkspaceBots,
  useWorkspaceDmPeers,
  useWorkspaceFromStore,
  useWorkspaceMetadata,
  useWorkspacePersonas,
  useWorkspaceSidebarConfig,
  useWorkspaceStreamMemberships,
  useWorkspaceStreams,
  useWorkspaceUnreadState,
  useWorkspaceUsers,
  type CachedUnreadState,
} from "@/stores/workspace-store"
import { hasSeededDraftCache, seedDraftCacheFromIdb } from "@/stores/draft-store"
import { reconcileStagedDrafts } from "@/sync/draft-sync"
import { useSyncSnapshot, useSyncStatus } from "@/sync/sync-status"
import { debugBootstrap, isBootstrapDebugEnabled } from "@/lib/bootstrap-debug"
import {
  QUERY_LOAD_STATE,
  getQueryLoadState,
  isQueryLoadStateLoading,
  shouldSuppressBootstrapError,
} from "@/lib/query-load-state"
import { StreamContentSkeleton } from "@/components/loading"
import { ApiError } from "@/api/client"
import { markInitialRevealComplete } from "@/sync/reveal-gate"
import { createSelectorContext } from "@/lib/selector-context"
import { isServerStreamId } from "@/lib/stream-ids"
import { getAvatarUrl } from "@threahq/types"
import { cn } from "@/lib/utils"

/**
 * Global coordinated loading phase - only applies during initial app load.
 * - "loading": First ~300ms of initial load, UI shows blank
 * - "skeleton": After ~300ms, UI shows skeleton placeholders
 * - "ready": Initial load complete, never returns to loading/skeleton
 */
export type CoordinatedPhase = "loading" | "skeleton" | "ready"

/**
 * Per-stream loading state - only reports loading AFTER initial load completes.
 * During initial load, all streams report "idle" (the global phase handles that).
 */
export type StreamState = "idle" | "loading" | "error"

interface StreamError {
  streamId: string
  status: number
  error: Error
}

interface CoordinatedLoadingContextValue {
  /** Global coordinated loading phase */
  phase: CoordinatedPhase

  /** True if any stream has an error (used by MainContentGate to show error pages) */
  hasErrors: boolean

  /** Get state for a specific stream. Returns "idle" during initial load. */
  getStreamState: (streamId: string) => StreamState

  /** Get error details for a stream in error state */
  getStreamError: (streamId: string) => StreamError | undefined

  /** True when any loading is happening (for topbar loading indicator) */
  isLoading: boolean

  /** True when loading indicator should be visible (after delay, same as skeleton) */
  showLoadingIndicator: boolean

  /** True once the workspace data is in: the content mounts, hidden until `phase` is "ready". */
  contentMounted: boolean

  /** Registers or removes (null) a surface the first reveal waits on. */
  setRevealParticipant: (key: string, participant: RevealParticipantState | null) => void
}

interface RevealParticipantState {
  label: string
  ready: boolean
}

const pickUnreadStateId = (state: CachedUnreadState) => state.id

const CoordinatedLoadingContext = createSelectorContext<CoordinatedLoadingContextValue | null>(null)

interface CoordinatedLoadingProviderProps {
  workspaceId: string
  streamIds: string[]
  children: ReactNode
}

/**
 * Delay before the top-bar loading indicator becomes visible in the global
 * initial-load gate (`CoordinatedLoadingProvider`) so fast switches never
 * flash it.
 */
export const LOADING_DELAY_MS = 300

/**
 * Delay before the loading skeleton becomes visible. Deliberately longer than
 * `LOADING_DELAY_MS`: a slightly-slow load that finishes within this window
 * should go blank → content with no skeleton at all, because a skeleton that
 * shows for a frame and is immediately replaced reads as a flicker. Only a
 * genuinely slow load — still loading past this delay — earns a skeleton.
 */
export const SKELETON_DELAY_MS = 600

/** The first reveal waits this long for its surfaces, then shows them anyway: a slow pane keeps its own loading state. */
export const REVEAL_CAP_MS = 3000

/**
 * The coordinated-loading phase machine, on its own so every surface that wants
 * this behaviour runs the SAME one (INV-35): blank while a load is young, a
 * skeleton only once it is genuinely slow, and content when the caller says it
 * is ready. `isReady` is the caller's readiness (the app gate latches it
 * one-way; a per-surface caller can simply derive it), and the skeleton is
 * sticky — it is never dropped back to blank between skeleton and content,
 * because that reads as a flicker.
 */
export function useCoordinatedPhase({
  isLoading,
  isReady,
}: {
  isLoading: boolean
  isReady: boolean
}): CoordinatedPhase {
  const [showSkeleton, setShowSkeleton] = useState(false)

  useEffect(() => {
    if (isReady) {
      setShowSkeleton(false)
      return
    }
    if (!isLoading) return

    const timer = setTimeout(() => setShowSkeleton(true), SKELETON_DELAY_MS)
    return () => clearTimeout(timer)
  }, [isLoading, isReady])

  if (isReady) return "ready"
  return showSkeleton ? "skeleton" : "loading"
}

export function CoordinatedLoadingProvider({ workspaceId, streamIds, children }: CoordinatedLoadingProviderProps) {
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(false)
  // Two latches: the data is in, so the content mounts hidden; then every
  // surface on show reports ready (or the cap passes), so it all reveals at once.
  const [contentMounted, setContentMounted] = useState(false)
  const [isReady, setIsReady] = useState(false)
  const participantsRef = useRef(new Map<string, RevealParticipantState>())
  const [participantsVersion, bumpParticipants] = useReducer((version: number) => version + 1, 0)
  // Track which workspace has IDB cache primed. When true, the gate bypasses
  // network checks — IDB has data from a previous session and store hooks
  // return it synchronously via the in-memory cache. The phase system still
  // applies (loading → skeleton → ready) including avatar preload.
  const [primedWorkspaceId, setPrimedWorkspaceId] = useState<string | null>(null)
  const [primedDraftWorkspaceId, setPrimedDraftWorkspaceId] = useState<string | null>(null)
  const idbCachePrimed = primedWorkspaceId === workspaceId
  const loadingIndicatorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideIndicatorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loggedSuppressedStreamErrorsRef = useRef(new Set<string>())
  // The first bootstrap after an IDB reveal still reports "syncing" — but that
  // is a background refresh of already-visible content, not a load. Surfacing
  // it on the topbar indicator made online feel slower than offline (which
  // never syncs, so never shows it). We only treat "syncing" as indicator-worthy
  // once that initial sync has gone quiet, so a later reconnect resync still
  // surfaces while the initial freshness pass stays silent.
  //
  // This is a one-way latch (false → true, never back), which is the whole
  // point: it must STAY true across the `isAnySyncing` false→true transition a
  // reconnect causes, so the reconnect indicator can fire. A plain
  // `!isAnySyncing` check inline would instead suppress the reconnect indicator
  // too (`!isAnySyncing && isAnySyncing` is always false). Reading it in render
  // is safe precisely because it's monotone — the render that needs the latched
  // value is driven by the reactive `isAnySyncing` flip, not by the ref write.
  const hasSettledInitialSyncRef = useRef(false)

  // Prime the in-memory cache from IndexedDB on mount. If IDB has workspace
  // data from a previous session, this populates the cache so store hooks
  // return real data on their first synchronous render. When successful, the
  // gate bypasses network wait — IDB IS the source of truth.
  useEffect(() => {
    let cancelled = false
    seedCacheFromIdb(workspaceId).then((hasData) => {
      if (!cancelled && hasData) setPrimedWorkspaceId(workspaceId)
    })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  useEffect(() => {
    let cancelled = false
    // Recover any synchronously-staged composer content into IDB BEFORE seeding
    // the draft cache, so a draft typed-then-reloaded (before its debounce
    // reached IDB) is already present when the composer first reads. A failed
    // recovery must never block the app — seed regardless.
    const run = async () => {
      try {
        await reconcileStagedDrafts(workspaceId)
      } catch (err) {
        console.error("Failed to recover staged drafts", err)
      }
      await seedDraftCacheFromIdb(workspaceId)
      if (!cancelled) setPrimedDraftWorkspaceId(workspaceId)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const workspaceSyncStatus = useSyncStatus(`workspace:${workspaceId}`)
  const syncSnapshot = useSyncSnapshot()
  const isAnySyncing = useMemo(
    () => Array.from(syncSnapshot.statuses.values()).some((status) => status === "syncing"),
    [syncSnapshot]
  )
  const { loadState: streamsLoadState, results } = useCoordinatedStreamQueries(workspaceId, streamIds)
  const serverStreamIds = useMemo(() => streamIds.filter(isServerStreamId), [streamIds])

  // When bypassing via IDB cache, verify the data is actually populated —
  // don't just trust the loading flags. usePreloadImages resolves immediately
  // for empty arrays (pre-cache) and then never blocks again, which can cause
  // the gate to open before store hooks have data.
  const idbWorkspace = useWorkspaceFromStore(workspaceId)
  const idbStreams = useWorkspaceStreams(workspaceId)
  const idbUsers = useWorkspaceUsers(workspaceId)
  const idbMemberships = useWorkspaceStreamMemberships(workspaceId)
  const idbDmPeers = useWorkspaceDmPeers(workspaceId)
  const idbPersonas = useWorkspacePersonas(workspaceId)
  const idbBots = useWorkspaceBots(workspaceId)
  const hasUnreadState = useWorkspaceUnreadState(workspaceId, pickUnreadStateId) !== undefined
  const idbMetadata = useWorkspaceMetadata(workspaceId)
  // The sidebar config gates the reveal alongside the other workspace entities:
  // without it the gate could open before the persisted layout resolved, and the
  // sidebar would render its DEFAULT fallback for a frame before popping to the
  // user's real layout. A row always exists after the first bootstrap (the server
  // seeds the default), so this only ever waits on a genuinely-unloaded config.
  const idbSidebarConfig = useWorkspaceSidebarConfig(workspaceId)
  // Wait on a sealed E2E name ONLY when the stream being revealed is itself
  // sealed — never the whole workspace. The content area shows the OPEN stream(s):
  // a plaintext stream (the common case, every DM included) already has its name
  // and must reveal immediately; other streams' sealed names are a sidebar concern
  // with their own per-row loader. The old `idbStreams.some(...)` here was the
  // multi-second blank — it held an already-cached plaintext DM behind decrypting
  // EVERY E2E scratchpad name in the workspace, each a network key-wrap fetch that
  // re-runs every refresh (the name cache is memory-only). Scoping to the open
  // streams keeps the legitimate wait — an open sealed scratchpad still resolves
  // its single name before paint so its header shows the real name, not a
  // placeholder — without gating unrelated content on unrelated names.
  const isSealedNamePending = useSealedNamePendingResolver(workspaceId)
  const streamById = useMemo(() => new Map(idbStreams.map((stream) => [stream.id, stream])), [idbStreams])
  const sealedNamesPending = useMemo(
    () => serverStreamIds.some((id) => isSealedNamePending(streamById.get(id))),
    [serverStreamIds, isSealedNamePending, streamById]
  )
  const workspaceDataReady =
    hasSeededWorkspaceCache(workspaceId) &&
    !!idbWorkspace &&
    hasUnreadState &&
    idbMetadata !== undefined &&
    idbSidebarConfig !== undefined
  const draftDataReady = primedDraftWorkspaceId === workspaceId && hasSeededDraftCache(workspaceId)
  const streamQueryStates = useMemo(
    () =>
      serverStreamIds.map((streamId, index) => {
        const result = results[index]
        const cachedStream = streamById.get(streamId)
        const hasStreamRecord = !!cachedStream || result?.data?.stream?.id === streamId
        // IDB is the source of truth — if the workspace was primed from IDB,
        // stream events are there and useLiveQuery will serve them. Otherwise
        // wait for the bootstrap query to resolve.
        const hasUsableLocalData = hasStreamRecord && (idbCachePrimed || result?.data !== undefined)
        return {
          streamId,
          result,
          hasStreamRecord,
          hasUsableLocalData,
          suppressError: shouldSuppressBootstrapError(result?.error, hasUsableLocalData),
        }
      }),
    [results, serverStreamIds, streamById, idbCachePrimed]
  )
  const visibleStreamIdsReady = streamQueryStates.every((state) => state.hasUsableLocalData)
  const canBypassVisibleStreamNetwork = idbCachePrimed && visibleStreamIdsReady
  const workspaceLoading = !workspaceDataReady && workspaceSyncStatus !== "error"
  const streamsLoading = !canBypassVisibleStreamNetwork && isQueryLoadStateLoading(streamsLoadState)
  const draftsLoading = !draftDataReady
  const suppressedStreamErrors = useMemo(
    () => streamQueryStates.filter((state) => state.suppressError && state.result?.error),
    [streamQueryStates]
  )

  const avatarUrls = useMemo(() => {
    return idbUsers
      .map((u) => getAvatarUrl(workspaceId, u.avatarUrl, 64))
      .filter((url): url is string => url !== undefined)
  }, [idbUsers, workspaceId])
  const avatarsReady = usePreloadImages(avatarUrls)

  // Avatar preloading avoids an avatar pop-in on the very first cold load, but
  // it hits the network — on a flaky connection those image requests hang until
  // the preload's 2s timeout, while offline they `onerror` instantly. Gating
  // the reveal on it makes a returning user wait longer "out and about" than
  // offline: their entire read model is already in IDB. So when the cache is
  // primed we reveal immediately (offline-first: cached content is never held
  // behind a network wait) and let avatars stream in through their own <img>
  // loads. Only a genuine cold load (nothing cached) still waits on the preload.
  const revealReady = avatarsReady || idbCachePrimed

  // After the initial coordinated load completes, stream-specific bootstraps
  // (triggered by navigating to a new stream) should not re-trigger the
  // top-bar loading indicator. Individual stream loading is handled by
  // EventList's skeleton/loading state within the stream content area.
  const dataLoading =
    workspaceLoading ||
    (!contentMounted && streamsLoading) ||
    draftsLoading ||
    (!contentMounted && sealedNamesPending) ||
    (isReady && hasSettledInitialSyncRef.current && isAnySyncing)
  const isLoading = dataLoading || (contentMounted && !isReady)

  const phase = useCoordinatedPhase({ isLoading, isReady })

  if (isBootstrapDebugEnabled()) {
    debugBootstrap("Coordinated loading state", {
      workspaceId,
      streamIds,
      serverStreamIds,
      workspaceSyncStatus,
      streamsLoadState,
      hasSeededWorkspaceCache: hasSeededWorkspaceCache(workspaceId),
      hasSeededDraftCache: hasSeededDraftCache(workspaceId),
      idbCachePrimed,
      workspaceDataReady,
      draftDataReady,
      visibleStreamIdsReady,
      suppressedStreamErrors: suppressedStreamErrors.map((state) => ({
        streamId: state.streamId,
        message: state.result?.error?.message ?? "unknown error",
      })),
      workspaceRecordReady: !!idbWorkspace,
      streamCount: idbStreams.length,
      userCount: idbUsers.length,
      membershipCount: idbMemberships.length,
      dmPeerCount: idbDmPeers.length,
      personaCount: idbPersonas.length,
      botCount: idbBots.length,
      hasUnreadState,
      hasMetadata: idbMetadata !== undefined,
      hasSidebarConfig: idbSidebarConfig !== undefined,
      workspaceLoading,
      streamsLoading,
      draftsLoading,
      sealedNamesPending,
      isAnySyncing,
      isLoading,
      contentMounted,
      isReady,
      phase,
      showLoadingIndicator,
    })
  }

  useEffect(() => {
    if (!import.meta.env.DEV) return

    for (const state of suppressedStreamErrors) {
      if (!state.result?.error) continue
      const key = `${workspaceId}:${state.streamId}:${state.result.error.message}`
      if (loggedSuppressedStreamErrorsRef.current.has(key)) continue
      loggedSuppressedStreamErrorsRef.current.add(key)
      console.warn(
        `[CoordinatedLoading] Suppressing stream bootstrap error for ${state.streamId} because cached data is available`,
        state.result.error
      )
    }
  }, [suppressedStreamErrors, workspaceId])

  // Mount the content once data is ready (and, on a cold load, avatars
  // preloaded — see `revealReady`).
  useEffect(() => {
    if (!dataLoading && revealReady) setContentMounted(true)
  }, [dataLoading, revealReady])

  const setRevealParticipant = useCallback((key: string, participant: RevealParticipantState | null) => {
    const participants = participantsRef.current
    if (participant) participants.set(key, participant)
    else participants.delete(key)
    bumpParticipants()
  }, [])

  // Surfaces register in layout effects, and one the grid uncovers in its
  // measured re-render registers a commit later than the rest: checking a frame
  // on lets every surface on show join before the reveal.
  useEffect(() => {
    if (!contentMounted || isReady) return
    const frame = requestAnimationFrame(() => {
      if ([...participantsRef.current.values()].every((participant) => participant.ready)) setIsReady(true)
    })
    return () => cancelAnimationFrame(frame)
  }, [contentMounted, isReady, participantsVersion])

  useEffect(() => {
    if (!contentMounted || isReady) return
    const timer = setTimeout(() => {
      const waiting = [...participantsRef.current.values()].filter((participant) => !participant.ready)
      // Empty in a background tab, where the frame check above never runs.
      if (waiting.length > 0) {
        console.warn(
          `[CoordinatedLoading] Revealing without ${waiting.map((participant) => participant.label).join(", ")} after ${REVEAL_CAP_MS}ms`
        )
      }
      setIsReady(true)
    }, REVEAL_CAP_MS)
    return () => clearTimeout(timer)
  }, [contentMounted, isReady])

  // Tell the background sync the cached content has rendered, so its first
  // bootstrap can commit to IndexedDB without starving the reads that gate it
  // (see reveal-gate.ts). Not on the reveal: a pane can wait on that commit (an
  // empty stream is only confirmed empty by its bootstrap), and the reveal would
  // wait on the pane. Idempotent across re-renders / StrictMode double-mounts.
  useEffect(() => {
    if (contentMounted) markInitialRevealComplete(workspaceId)
  }, [contentMounted, workspaceId])

  // Once the content is revealed AND the initial background sync has gone quiet,
  // any future "syncing" is a reconnect resync — that one is worth surfacing on
  // the topbar indicator (see `isLoading`). The initial freshness pass that
  // overlaps the first reveal is deliberately excluded so it stays silent.
  useEffect(() => {
    if (isReady && !isAnySyncing) hasSettledInitialSyncRef.current = true
  }, [isReady, isAnySyncing])

  // Show loading indicator after delay (for slow loads)
  // This shows for both initial loads AND reconnect loads
  useEffect(() => {
    if (isLoading) {
      if (hideIndicatorTimerRef.current) {
        clearTimeout(hideIndicatorTimerRef.current)
        hideIndicatorTimerRef.current = null
      }
      loadingIndicatorTimerRef.current = setTimeout(() => {
        setShowLoadingIndicator(true)
      }, LOADING_DELAY_MS)
    } else {
      if (loadingIndicatorTimerRef.current) {
        clearTimeout(loadingIndicatorTimerRef.current)
        loadingIndicatorTimerRef.current = null
      }
      // Small delay before hiding for smooth transition
      hideIndicatorTimerRef.current = setTimeout(() => setShowLoadingIndicator(false), 100)
    }

    return () => {
      if (loadingIndicatorTimerRef.current) {
        clearTimeout(loadingIndicatorTimerRef.current)
      }
      if (hideIndicatorTimerRef.current) {
        clearTimeout(hideIndicatorTimerRef.current)
      }
    }
  }, [isLoading])

  const nextStreamStateMap = useMemo(() => {
    const map: StreamLoadStates = new Map()

    streamQueryStates.forEach((state) => {
      const syncStatus = syncSnapshot.statuses.get(`stream:${state.streamId}`) ?? "idle"
      const syncError = syncSnapshot.errors.get(`stream:${state.streamId}`) ?? null
      const loadState = state.result
        ? getQueryLoadState(state.result.status, state.result.fetchStatus)
        : QUERY_LOAD_STATE.READY

      if (!state.result && !syncError && syncStatus === "idle") return

      map.set(state.streamId, {
        isLoading:
          !syncError &&
          (syncStatus === "syncing" ||
            (state.result ? isQueryLoadStateLoading(loadState) && !state.result.isError : false)),
        error: syncError?.error ?? (state.suppressError ? null : (state.result?.error ?? null)),
      })
    })

    return map
  }, [streamQueryStates, syncSnapshot])
  // Recomputed on every stream-row write and sync tick; the getters below are
  // context values, so they must keep their identity while the answers hold.
  const streamStateMap = useStableWhile(nextStreamStateMap, sameStreamStates)

  const nextStreamErrors = useMemo<StreamError[]>(() => {
    return streamQueryStates
      .map((state) => {
        const syncError = syncSnapshot.errors.get(`stream:${state.streamId}`)
        if (syncError) {
          return {
            streamId: state.streamId,
            status: syncError.status ?? 500,
            error: syncError.error,
          }
        }
        if (!state.result?.error || state.suppressError) return null
        const status = ApiError.isApiError(state.result.error) ? state.result.error.status : 500
        return { streamId: state.streamId, status, error: state.result.error }
      })
      .filter((e): e is StreamError => e !== null)
  }, [streamQueryStates, syncSnapshot])
  const streamErrors = useStableWhile(nextStreamErrors, sameStreamErrors)

  const getStreamState = useMemo(
    () =>
      (streamId: string): StreamState => {
        // During initial load, all streams report "idle" - the global phase controls skeleton display.
        // This is intentional: individual stream loading indicators only appear AFTER initial load.
        if (!isReady) return "idle"

        // Client-side ids are always idle (no server fetch)
        if (!isServerStreamId(streamId)) return "idle"

        const state = streamStateMap.get(streamId)
        if (!state) return "idle"
        if (state.error) return "error"
        if (state.isLoading) return "loading"
        return "idle"
      },
    [isReady, streamStateMap]
  )

  const getStreamError = useMemo(
    () => (streamId: string) => streamErrors.find((e) => e.streamId === streamId),
    [streamErrors]
  )

  const hasErrors = streamErrors.length > 0

  const value = useMemo<CoordinatedLoadingContextValue>(
    () => ({
      phase,
      hasErrors,
      getStreamState,
      getStreamError,
      isLoading,
      showLoadingIndicator,
      contentMounted,
      setRevealParticipant,
    }),
    [
      phase,
      hasErrors,
      getStreamState,
      getStreamError,
      isLoading,
      showLoadingIndicator,
      contentMounted,
      setRevealParticipant,
    ]
  )

  return <CoordinatedLoadingContext.Provider value={value}>{children}</CoordinatedLoadingContext.Provider>
}

function useStableWhile<T>(next: T, isSame: (previous: T, next: T) => boolean): T {
  const ref = useRef(next)
  if (ref.current !== next && !isSame(ref.current, next)) ref.current = next
  return ref.current
}

type StreamLoadStates = Map<string, { isLoading: boolean; error: Error | null }>

function sameStreamStates(previous: StreamLoadStates, next: StreamLoadStates): boolean {
  if (previous.size !== next.size) return false
  for (const [streamId, state] of next) {
    const before = previous.get(streamId)
    if (!before || before.isLoading !== state.isLoading || before.error !== state.error) return false
  }
  return true
}

function sameStreamErrors(previous: StreamError[], next: StreamError[]): boolean {
  return (
    previous.length === next.length &&
    next.every((error, index) => {
      const before = previous[index]
      return before.streamId === error.streamId && before.status === error.status && before.error === error.error
    })
  )
}

/** Reads one field: the indicator and per-stream fields flip on every stream switch, and most readers want only `phase`. */
export function useCoordinatedLoading<T>(select: (value: CoordinatedLoadingContextValue) => T): T {
  return CoordinatedLoadingContext.useSelector((value) => {
    if (!value) {
      throw new Error("useCoordinatedLoading must be used within a CoordinatedLoadingProvider")
    }
    return select(value)
  })
}

const RevealReadyContext = createContext<((ready: boolean) => void) | null>(null)

/**
 * A surface the first reveal waits on while it is on show (not `covered`).
 * Fail-closed: it starts not ready, so content inside that never reports
 * through {@link useRevealReady} holds the reveal to the cap and is named in
 * the warning.
 */
export function RevealParticipant({
  label,
  covered,
  children,
}: {
  label: string
  covered: boolean
  children: ReactNode
}) {
  const key = useId()
  const [ready, setReady] = useState(false)
  // Outside a provider (a component mounted on its own) there is no reveal to wait.
  const setParticipant = CoordinatedLoadingContext.useSelector((loading) => loading?.setRevealParticipant ?? null)
  const revealed = CoordinatedLoadingContext.useSelector((loading) => !loading || loading.phase === "ready")
  useLayoutEffect(() => {
    if (covered || revealed || !setParticipant) return
    setParticipant(key, { label, ready })
    return () => setParticipant(key, null)
  }, [setParticipant, key, label, ready, covered, revealed])
  return <RevealReadyContext.Provider value={setReady}>{children}</RevealReadyContext.Provider>
}

/** Reports the enclosing {@link RevealParticipant} ready once `ready` holds. One-way; a no-op outside one. */
export function useRevealReady(ready: boolean) {
  const setReady = useContext(RevealReadyContext)
  useLayoutEffect(() => {
    if (ready) setReady?.(true)
  }, [ready, setReady])
}

/** Opacity, not visibility: hidden content keeps its layout and can take focus. */
export const HIDDEN_CHILDREN = "[&>*]:pointer-events-none [&>*]:opacity-0"

interface CoordinatedLoadingGateProps {
  children: ReactNode
}

/**
 * Shows nothing for a young initial load, the shell (with its skeletons) once
 * the load is slow. Content mounts as soon as the data is in, invisible until
 * the reveal, so panes settle behind it and the composer can take focus.
 */
export function CoordinatedLoadingGate({ children }: CoordinatedLoadingGateProps) {
  const phase = useCoordinatedLoading((loading) => loading.phase)
  const contentMounted = useCoordinatedLoading((loading) => loading.contentMounted)

  if (phase === "loading" && !contentMounted) return null

  return <div className={cn("contents", phase === "loading" && HIDDEN_CHILDREN)}>{children}</div>
}

/**
 * Gate for the main content area (Outlet): a skeleton while the data loads,
 * then the content mounted hidden under it until the reveal.
 * Individual stream components handle their own loading states after that.
 */
export function MainContentGate({ children }: CoordinatedLoadingGateProps) {
  const phase = useCoordinatedLoading((loading) => loading.phase)
  const contentMounted = useCoordinatedLoading((loading) => loading.contentMounted)
  const hasErrors = useCoordinatedLoading((loading) => loading.hasErrors)

  // Errors render the content so error pages can display.
  if (!contentMounted && !hasErrors) return <StreamContentSkeleton />

  const hidden = phase !== "ready" && !hasErrors
  return (
    <>
      <div className={cn("contents", hidden && HIDDEN_CHILDREN)}>{children}</div>
      {hidden && phase === "skeleton" && (
        <div className="absolute inset-0 z-10 bg-background">
          <StreamContentSkeleton />
        </div>
      )}
    </>
  )
}
