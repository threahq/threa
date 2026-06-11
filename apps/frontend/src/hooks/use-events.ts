import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useStreamBootstrap } from "./use-streams"
import { useStreamService } from "@/contexts"
import { useQueryClient, useInfiniteQuery } from "@tanstack/react-query"
import { db, sequenceToNum } from "@/db"
import { EVENT_PAGE_SIZE } from "@/lib/constants"
import { useStreamEvents } from "@/stores/stream-store"
import { isTerminalBootstrapError, shouldSuppressBootstrapError } from "@/lib/query-load-state"
import { computeTimelineHoles, holesSignature, type TimelineHole } from "@/sync/contiguity"
import { useOptionalSyncEngine } from "@/sync/sync-engine"
import type { StreamEvent, EventsAroundResponse, SharedMessageHydration } from "@threa/types"

export const eventKeys = {
  all: ["events"] as const,
  list: (workspaceId: string, streamId: string) => [...eventKeys.all, "list", workspaceId, streamId] as const,
  newer: (workspaceId: string, streamId: string) => [...eventKeys.all, "newer", workspaceId, streamId] as const,
}

/** Spacing/cap for re-requesting a backfill while the same holes persist. */
const HOLE_BACKFILL_RETRY_MS = 15_000
const HOLE_BACKFILL_MAX_ATTEMPTS = 3

interface JumpState {
  events: StreamEvent[]
  hasOlder: boolean
  hasNewer: boolean
  /** Sequence of the oldest event in the jump window — cursor for backward pagination */
  oldestSequence: string
  /** Sequence of the newest event in the jump window — cursor for forward pagination */
  newestSequence: string
  /**
   * Hydration map for `sharedMessage` pointers landing in the jump window.
   * Merged with bootstrap + paginated maps via `useEvents().pagedSharedMessages`
   * so jumping to a message containing a pointer renders content immediately
   * instead of falling back to the IDB / skeleton path.
   */
  sharedMessages?: Record<string, SharedMessageHydration>
}

type SequencedEvent = Pick<StreamEvent, "sequence">
type DisplayableEvent = SequencedEvent & { _status?: string | null }
export interface BootstrapFloorState {
  streamId: string
  floor: bigint
  windowVersion: number
}

export function getMinimumSequence(events: Array<Pick<StreamEvent, "sequence">> | null | undefined): bigint | null {
  if (!events || events.length === 0) return null

  let min = BigInt(events[0].sequence)
  for (let i = 1; i < events.length; i++) {
    const seq = BigInt(events[i].sequence)
    if (seq < min) min = seq
  }
  return min
}

/**
 * Grace period before `idbResolved=false` flips the timeline to a skeleton.
 * Short enough that fast resolves don't flash a skeleton; long enough that a
 * stuck resolve never leaves the timeline visibly blank with no indicator.
 *
 * Sibling of `LOADING_DELAY_MS` (300ms) in `coordinated-loading-context.tsx`
 * which governs the initial workspace-level load. This one is shorter because
 * it applies after initial load, on a per-stream switch, where users expect
 * faster feedback. When tuning either, consider both.
 */
export const IDB_SKELETON_DELAY_MS = 200

export interface TimelineLoadStateInput {
  /** `true` once `useLiveQuery` has returned a result stamped with the current streamId. */
  idbResolved: boolean
  /** `true` when either IDB or the cached bootstrap snapshot has something to render. */
  hasAnyEvents: boolean
  /**
   * `true` once the bootstrap query has produced a *definitive* answer for
   * this stream: it succeeded, hit a terminal 403/404, or the caller disabled
   * it (drafts). It is `false` while the bootstrap is pending, fetching, or
   * blocked waiting for the socket to connect.
   *
   * Critical: a disabled / socket-gated bootstrap is NOT an empty stream.
   * Treating "bootstrap not currently loading" as "stream confirmed empty" is
   * what makes a stream with thousands of messages render "No messages yet"
   * after a cold push-notification open. Only the bootstrap's own definitive
   * answer can confirm emptiness; until then an empty IDB stays a skeleton.
   */
  bootstrapSettled: boolean
  /**
   * `true` once IDB has been unresolved for `IDB_SKELETON_DELAY_MS`. Callers
   * pass `false` until the timeout fires so fast stream switches don't flash
   * a skeleton.
   */
  idbResolveTimedOut: boolean
}

export interface TimelineLoadState {
  /** Render a skeleton — we're actively waiting on data. */
  isLoading: boolean
  /** Render "No messages yet" — both data sources confirmed empty. */
  isConfirmedEmpty: boolean
}

/**
 * Decide whether the timeline should render a skeleton, an empty state, or
 * pass through to the virtualized scroll area.
 *
 * Invariant: a blank scroll area is never a terminal state. Either we have
 * events, we're loading (skeleton), or we're confirmed empty (empty state).
 */
export function computeTimelineLoadState({
  idbResolved,
  hasAnyEvents,
  bootstrapSettled,
  idbResolveTimedOut,
}: TimelineLoadStateInput): TimelineLoadState {
  if (!idbResolved) {
    // Grace window: pretend neither loading nor empty so fast stream switches
    // render briefly blank without a skeleton flash. Past the timeout, flip to
    // the skeleton so slow devices don't appear frozen.
    return { isLoading: idbResolveTimedOut, isConfirmedEmpty: false }
  }
  if (hasAnyEvents) {
    return { isLoading: false, isConfirmedEmpty: false }
  }
  // IDB resolved empty. Keep a skeleton until the bootstrap actually answers —
  // a pending / socket-gated bootstrap must never be reported as a confirmed
  // empty stream. Only the bootstrap's definitive answer flips this to the
  // empty state.
  return { isLoading: !bootstrapSettled, isConfirmedEmpty: bootstrapSettled }
}

export function getDisplayFloor(bootstrapFloor: bigint | null, olderFloor: bigint | null): bigint | null {
  if (bootstrapFloor === null) return olderFloor
  if (olderFloor === null) return bootstrapFloor
  return olderFloor < bootstrapFloor ? olderFloor : bootstrapFloor
}

export function getCachedWindowFloor<T extends DisplayableEvent>(events: T[], pageSize: number): bigint | null {
  const persistedEvents = events.filter((event) => event._status !== "pending" && event._status !== "failed")
  if (persistedEvents.length <= pageSize) return null

  const firstVisibleEvent = persistedEvents[persistedEvents.length - pageSize]
  return BigInt(firstVisibleEvent.sequence)
}

export function filterEventsForDisplay<T extends DisplayableEvent>(events: T[], displayFloor: bigint | null): T[] {
  if (displayFloor === null) return events

  return events.filter((event) => {
    if (event._status === "pending" || event._status === "failed") return true
    return BigInt(event.sequence) >= displayFloor
  })
}

/**
 * Offline-first render guarantee: a non-empty local cache must never render as
 * a blank timeline.
 *
 * `displayFloor` exists to trim *pre-session* history so the unread divider
 * and pagination cursors stay correct — it is an optimisation for narrowing
 * the window, never a reason to render nothing. But the floor is derived from
 * the bootstrap's latest page, and a freshly-fetched bootstrap floor can land
 * entirely above a stale cached window before `useLiveQuery` re-emits the
 * bootstrap's own writes (Dexie change-propagation lag; on mobile Safari the
 * change can be missed until the next page-resume). In that gap
 * `filterEventsForDisplay` would strip every cached event, the rendered array
 * goes empty while `hasAnyEvents` (computed from the unfiltered set) stays
 * true, and the timeline commits to a permanent blank scroll area — no
 * skeleton, no empty state — until a hard refresh.
 *
 * The invariant: if IndexedDB has events for this stream, the user sees them.
 * If applying the floor would hide the entire cached set, show the full
 * cached set instead and let the background bootstrap refresh widen/correct
 * the window on its next emit.
 */
export function getRenderableEvents<T extends DisplayableEvent>(events: T[], displayFloor: bigint | null): T[] {
  const filtered = filterEventsForDisplay(events, displayFloor)
  if (filtered.length === 0 && events.length > 0) return events
  return filtered
}

/**
 * Pick the source of events to render in the timeline.
 *
 * IDB is the primary read model — once it has events, it always wins because
 * it carries socket-arrived events and optimistic pending/failed rows that
 * the bootstrap snapshot doesn't.
 *
 * The bootstrap fallback closes a narrow but visible race on cold load: the
 * bootstrap query writes events to IDB inside its queryFn, then resolves and
 * triggers a re-render. `useLiveQuery` only refreshes once Dexie's change
 * notifications propagate, which can land one or more renders later (and on
 * mobile Safari has been observed to miss the change entirely until the next
 * page-resume). Without the fallback, that interim render computes
 * `hasAnyEvents=true` from `bootstrap.events` while the rendered array stays
 * empty — neither the skeleton nor the empty state fires and the user sees
 * a blank scroll area.
 *
 * Falling back to bootstrap is safe specifically because IDB is empty: there
 * are no socket-arrived or pending events to hide. As soon as `useLiveQuery`
 * picks up the bootstrap writes, control flips back to IDB seamlessly.
 */
export function getEffectiveEvents<T extends DisplayableEvent>(
  idbResolved: boolean,
  idbEvents: T[],
  bootstrapEvents: T[]
): T[] {
  if (!idbResolved) return []
  if (idbEvents.length > 0) return idbEvents
  return bootstrapEvents
}

export function getOldestSequence(events: SequencedEvent[] | null | undefined): string | null {
  if (!events || events.length === 0) return null

  let oldest = events[0]
  let oldestValue = BigInt(oldest.sequence)
  for (let i = 1; i < events.length; i++) {
    const value = BigInt(events[i].sequence)
    if (value < oldestValue) {
      oldest = events[i]
      oldestValue = value
    }
  }

  return oldest.sequence
}

export function getNextBootstrapFloorState(
  current: BootstrapFloorState | null,
  streamId: string,
  newFloor: bigint | null,
  windowVersion: number
): { state: BootstrapFloorState | null; floor: bigint | null } {
  let nextCurrent = current

  if (nextCurrent && (nextCurrent.streamId !== streamId || nextCurrent.windowVersion !== windowVersion)) {
    nextCurrent = null
  }

  if (newFloor === null) {
    return { state: nextCurrent, floor: nextCurrent?.floor ?? null }
  }

  if (nextCurrent !== null && nextCurrent.floor < newFloor) {
    return { state: nextCurrent, floor: nextCurrent.floor }
  }

  const nextState = { streamId, floor: newFloor, windowVersion }
  return { state: nextState, floor: newFloor }
}

function sortBySequence(events: StreamEvent[]): StreamEvent[] {
  return [...events].sort((a, b) => {
    const seqA = BigInt(a.sequence)
    const seqB = BigInt(b.sequence)
    if (seqA < seqB) return -1
    if (seqA > seqB) return 1
    return 0
  })
}

function dedupeAndSort(eventArrays: StreamEvent[][]): StreamEvent[] {
  const eventMap = new Map<string, StreamEvent>()
  for (const arr of eventArrays) {
    for (const event of arr) {
      eventMap.set(event.id, event)
    }
  }
  return sortBySequence(Array.from(eventMap.values()))
}

async function cacheToIndexedDB(workspaceId: string, events: StreamEvent[]) {
  if (events.length === 0) return
  const now = Date.now()
  await db.events.bulkPut(
    events.map((e) => ({ ...e, workspaceId, _sequenceNum: sequenceToNum(e.sequence), _cachedAt: now }))
  )
}

export function useEvents(workspaceId: string, streamId: string, options?: { enabled?: boolean; loadAll?: boolean }) {
  const shouldFetch = options?.enabled ?? true

  // Bootstrap query still drives the fetch lifecycle (loading/error states)
  // and triggers IDB writes via applyStreamBootstrap in its queryFn.
  const {
    status: bootstrapStatus,
    error,
    data: bootstrap,
  } = useStreamBootstrap(workspaceId, streamId, {
    enabled: shouldFetch,
  })

  // The bootstrap has a *definitive* answer only when it succeeded, hit a
  // terminal 403/404, or the caller never asked for it (drafts). While it is
  // pending / fetching / blocked on the socket connecting, it has NOT
  // confirmed the stream is empty — an empty IDB must stay a skeleton, not
  // flip to "No messages yet" for a stream that actually has history.
  const bootstrapSettled = !shouldFetch || bootstrapStatus === "success" || isTerminalBootstrapError(error)
  const streamService = useStreamService()
  const queryClient = useQueryClient()

  // Jump-to-message state: when set, replaces bootstrap as the anchor window
  const [jumpState, setJumpState] = useState<JumpState | null>(null)
  const lastSuppressedErrorKeyRef = useRef<string | null>(null)

  // Infinite query for older events (backward pagination).
  // enabled: false — never auto-fetches. Triggered exclusively via seed + fetchOlderPage().
  const {
    data: olderData,
    fetchNextPage: fetchOlderPage,
    hasNextPage: hasOlderPage,
    isFetchingNextPage: isFetchingOlder,
  } = useInfiniteQuery({
    queryKey: eventKeys.list(workspaceId, streamId),
    queryFn: async ({ pageParam }) => {
      if (!pageParam) {
        return {
          events: [] as StreamEvent[],
          hasMore: false,
          cursor: undefined,
          sharedMessages: undefined as Record<string, SharedMessageHydration> | undefined,
        }
      }
      const result = await streamService.getEvents(workspaceId, streamId, {
        before: pageParam,
        limit: EVENT_PAGE_SIZE,
      })
      // Write fetched events to IDB — they become available via useStreamEvents
      await cacheToIndexedDB(workspaceId, result.events)
      return {
        events: result.events,
        hasMore: result.events.length === EVENT_PAGE_SIZE,
        cursor: undefined,
        sharedMessages: result.sharedMessages,
      }
    },
    getNextPageParam: (lastPage) => {
      if (!lastPage.hasMore) return undefined
      if (lastPage.events.length === 0) return lastPage.cursor
      return lastPage.events[0].sequence
    },
    initialPageParam: undefined as string | undefined,
    enabled: false,
  })

  // Infinite query for newer events (forward pagination, only active in jump-to mode).
  const {
    data: newerData,
    fetchNextPage: fetchNewerPage,
    hasNextPage: hasNewerPage,
    isFetchingNextPage: isFetchingNewer,
  } = useInfiniteQuery({
    queryKey: eventKeys.newer(workspaceId, streamId),
    queryFn: async ({ pageParam }) => {
      if (!pageParam) {
        return {
          events: [] as StreamEvent[],
          hasMore: false,
          cursor: undefined,
          sharedMessages: undefined as Record<string, SharedMessageHydration> | undefined,
        }
      }
      const result = await streamService.getEvents(workspaceId, streamId, {
        after: pageParam,
        limit: EVENT_PAGE_SIZE,
      })
      await cacheToIndexedDB(workspaceId, result.events)
      return {
        events: result.events,
        hasMore: result.events.length === EVENT_PAGE_SIZE,
        cursor: undefined,
        sharedMessages: result.sharedMessages,
      }
    },
    getNextPageParam: (lastPage) => {
      if (!lastPage.hasMore) return undefined
      if (lastPage.events.length === 0) return lastPage.cursor
      return lastPage.events[lastPage.events.length - 1].sequence
    },
    initialPageParam: undefined as string | undefined,
    enabled: false,
  })

  // The bootstrap's oldest event sequence defines the lower bound of the
  // display window. Events older than this are from previous sessions and
  // should not be shown (they'd break unread divider positioning and cause
  // stale data to appear). Events at or newer than this bound include:
  // - All bootstrap events
  // - Socket events that arrived during or after bootstrap (INV-53 guarantee)
  // - Pending/failed optimistic events (regardless of sequence)
  //
  // The floor must never jump upward on re-fetches (e.g. after socket reconnect).
  // A higher floor would hide events already visible in IDB from the current
  // session — the events are valid, just below the latest bootstrap page.
  //
  // NOTE: The ref mutation inside useMemo is intentional. Moving it to useEffect
  // would introduce a one-render lag where the higher floor is applied before the
  // ratchet corrects it, causing a visible flash of hidden messages. The mutation
  // is idempotent for identical inputs so strict-mode double-invocation is safe.
  const bootstrapFloorRef = useRef<BootstrapFloorState | null>(null)
  const bootstrapFloor = useMemo(() => {
    const next = getNextBootstrapFloorState(
      bootstrapFloorRef.current,
      streamId,
      getMinimumSequence(bootstrap?.events),
      bootstrap?.windowVersion ?? 0
    )
    bootstrapFloorRef.current = next.state
    return next.floor
  }, [bootstrap?.events, bootstrap?.windowVersion, streamId])

  const olderFloor = useMemo(() => {
    const olderEvents = olderData?.pages.flatMap((page) => page.events).filter(Boolean) ?? []
    return getMinimumSequence(olderEvents)
  }, [olderData])

  // Primary data source: IndexedDB via useLiveQuery.
  // When a server-derived floor is known (bootstrap + older pagination),
  // pass it as the IDB lower bound so paginated older events are included
  // in the query results instead of being cut off by a fixed count limit.
  // When no floor is known (pre-bootstrap), IDB falls back to a count-based
  // cap for bounded initial load.
  const idbFloor = useMemo(() => getDisplayFloor(bootstrapFloor, olderFloor), [bootstrapFloor, olderFloor])
  const idbFloorNum = idbFloor !== null ? Number(idbFloor) : null
  const idbEvents = useStreamEvents(streamId, idbFloorNum)

  const idbResolved = idbEvents !== undefined
  const hasIdbEvents = idbResolved && idbEvents.length > 0
  const suppressBootstrapError = shouldSuppressBootstrapError(error, hasIdbEvents)

  // IDB is the primary read model. When useLiveQuery resolves with content,
  // we always use it — it carries socket-arrived events and optimistic
  // pending/failed rows the bootstrap snapshot doesn't. The bootstrap-events
  // fallback only fires when IDB is genuinely empty, closing the cold-load
  // race where bootstrap has finished but Dexie change events haven't yet
  // propagated to useLiveQuery (see getEffectiveEvents docstring).
  const effectiveEvents: DisplayableEvent[] = getEffectiveEvents(idbResolved, idbEvents ?? [], bootstrap?.events ?? [])
  const hasAnyEvents = effectiveEvents.length > 0

  const cachedWindowFloor = useMemo(() => getCachedWindowFloor(effectiveEvents, EVENT_PAGE_SIZE), [effectiveEvents])
  const displayFloor = useMemo(() => {
    const serverFloor = getDisplayFloor(bootstrapFloor, olderFloor)
    if (serverFloor !== null) return serverFloor
    if (suppressBootstrapError) return null
    return cachedWindowFloor
  }, [bootstrapFloor, olderFloor, suppressBootstrapError, cachedWindowFloor])

  // Combine all event sources.
  // In jump mode: use jump window + paginated older/newer events.
  // In normal mode: filter IDB/bootstrap events to display window.
  const events = useMemo(() => {
    if (jumpState) {
      const olderEvents = olderData?.pages.flatMap((page) => page.events).filter(Boolean) ?? []
      const newerEvents = newerData?.pages.flatMap((page) => page.events).filter(Boolean) ?? []
      return dedupeAndSort([jumpState.events, olderEvents, newerEvents])
    }

    // Before bootstrap resolves, show only a bootstrap-sized cached window so
    // users cannot scroll into extra cached history that later disappears when
    // the bootstrap floor arrives. If bootstrap fails and we fall back to the
    // local cache, widen back out to the full cached timeline. The floor must
    // never hide the entire cached set — a non-empty IDB always renders
    // something (see getRenderableEvents).
    return getRenderableEvents(effectiveEvents, displayFloor) as unknown as StreamEvent[]
  }, [effectiveEvents, olderData, newerData, jumpState, displayFloor])

  // Contiguity gate (INV-61): detect holes in the broadcast chain of the
  // rendered window. Each hole renders as an in-place loading placeholder
  // (see injectGapItems in event-list) and is backfilled via the engine's
  // single-flighted gap fetch, so the missed message resolves the
  // placeholder where it belongs instead of popping in above rows already
  // on screen. Jump mode is exempt — its window is a single contiguous
  // server response, and holes against the live tail are expected there.
  const syncEngine = useOptionalSyncEngine()
  const holes = useMemo<TimelineHole[]>(() => (jumpState ? [] : computeTimelineHoles(events)), [events, jumpState])
  const holesKey = holesSignature(holes)
  const holesRef = useRef(holes)
  holesRef.current = holes

  useEffect(() => {
    if (!syncEngine || holesKey === "") return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0

    // Re-request a few times while the SAME holes persist (transient fetch
    // failures, server lag), then leave the placeholder to the next
    // reconnect/navigation refresh. A filled hole changes holesKey, which
    // cancels the retry chain via cleanup.
    const request = () => {
      if (cancelled) return
      attempt++
      for (const hole of holesRef.current) {
        void syncEngine.backfillStreamGap(streamId, hole.afterSequence)
      }
      if (attempt < HOLE_BACKFILL_MAX_ATTEMPTS) {
        timer = setTimeout(request, HOLE_BACKFILL_RETRY_MS)
      }
    }
    request()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [holesKey, syncEngine, streamId])

  // When IDB has been unresolved long enough that a user would notice, flip
  // the timeline to the skeleton instead of leaving it blank. Fast switches
  // clear the timer before it fires, so the flicker-free path is preserved
  // for the common case.
  const [idbResolveTimedOut, setIdbResolveTimedOut] = useState(false)
  useEffect(() => {
    if (idbResolved) {
      setIdbResolveTimedOut(false)
      return
    }
    const timer = setTimeout(() => setIdbResolveTimedOut(true), IDB_SKELETON_DELAY_MS)
    return () => clearTimeout(timer)
  }, [idbResolved])

  const { isLoading, isConfirmedEmpty } = computeTimelineLoadState({
    idbResolved,
    hasAnyEvents,
    bootstrapSettled,
    idbResolveTimedOut,
  })

  useEffect(() => {
    if (!import.meta.env.DEV || !suppressBootstrapError || !error) return
    const key = `${streamId}:${error.message}`
    if (lastSuppressedErrorKeyRef.current === key) return
    lastSuppressedErrorKeyRef.current = key
    console.warn(`[useEvents] Suppressing bootstrap error for ${streamId} because local timeline data exists`, error)
  }, [suppressBootstrapError, error, streamId])

  // Determine if older events exist.
  const hasOlderEvents = useMemo(() => {
    if (hasOlderPage) return true
    const hasRunQuery = (olderData?.pages.length ?? 0) > 0
    if (hasRunQuery) return false
    if (jumpState) return jumpState.hasOlder
    return bootstrap?.hasOlderEvents ?? false
  }, [hasOlderPage, jumpState, olderData?.pages.length, bootstrap?.hasOlderEvents])

  // Determine if newer events exist (only in jump mode).
  const hasNewerEvents = useMemo(() => {
    if (!jumpState) return false
    if (hasNewerPage) return true
    const hasRunQuery = (newerData?.pages.length ?? 0) > 0
    if (hasRunQuery) return false
    return jumpState.hasNewer
  }, [jumpState, hasNewerPage, newerData?.pages.length])

  const fetchOlderEvents = useCallback(() => {
    if (isFetchingOlder) return false

    if (hasOlderPage) {
      void fetchOlderPage()
      return true
    }

    // Seed with a cursor-only page, then fetch immediately.
    const oldestSequence = getOldestSequence(jumpState ? jumpState.events : events)
    if (!oldestSequence) return false
    queryClient.setQueryData(eventKeys.list(workspaceId, streamId), {
      pages: [{ events: [], hasMore: true, cursor: oldestSequence }],
      pageParams: [undefined],
    })
    void fetchOlderPage()
    return true
  }, [isFetchingOlder, hasOlderPage, jumpState, events, queryClient, workspaceId, streamId, fetchOlderPage])

  // Auto-load all older events on mount when loadAll is true (e.g. thread panels)
  const loadAll = options?.loadAll ?? false
  useEffect(() => {
    if (!loadAll || !hasOlderEvents || isFetchingOlder) return
    fetchOlderEvents()
  }, [loadAll, hasOlderEvents, isFetchingOlder, fetchOlderEvents])

  const fetchNewerEvents = useCallback(() => {
    if (!jumpState || isFetchingNewer) return false

    if (hasNewerPage) {
      void fetchNewerPage()
      return true
    }

    queryClient.setQueryData(eventKeys.newer(workspaceId, streamId), {
      pages: [{ events: [], hasMore: true, cursor: jumpState.newestSequence }],
      pageParams: [undefined],
    })
    void fetchNewerPage()
    return true
  }, [jumpState, isFetchingNewer, hasNewerPage, queryClient, workspaceId, streamId, fetchNewerPage])

  /**
   * Jump to a specific event (e.g. from search or push notification deep link).
   * Loads events around it and switches to bidirectional pagination mode.
   */
  const jumpToEvent = useCallback(
    async (targetMessageId: string): Promise<boolean> => {
      const result: EventsAroundResponse = await streamService.getEventsAround(
        workspaceId,
        streamId,
        targetMessageId,
        EVENT_PAGE_SIZE
      )
      if (result.events.length === 0) return false

      // Write to IDB so they persist across sessions
      await cacheToIndexedDB(workspaceId, result.events)

      // If there are no newer events, the target is already at the bottom —
      // skip jump mode and let the live tail render from IDB.
      if (!result.hasNewer) return true

      const sorted = sortBySequence([...result.events])
      setJumpState({
        events: sorted,
        hasOlder: result.hasOlder,
        hasNewer: result.hasNewer,
        oldestSequence: sorted[0].sequence,
        newestSequence: sorted[sorted.length - 1].sequence,
        sharedMessages: result.sharedMessages,
      })

      // Reset pagination caches for this stream
      queryClient.removeQueries({ queryKey: eventKeys.list(workspaceId, streamId) })
      queryClient.removeQueries({ queryKey: eventKeys.newer(workspaceId, streamId) })

      return true
    },
    [streamService, workspaceId, streamId, queryClient]
  )

  /** Exit jump mode and return to live tail (latest messages from IDB). */
  const exitJumpMode = useCallback(() => {
    setJumpState(null)
    queryClient.removeQueries({ queryKey: eventKeys.list(workspaceId, streamId) })
    queryClient.removeQueries({ queryKey: eventKeys.newer(workspaceId, streamId) })
  }, [queryClient, workspaceId, streamId])

  // addEvent and updateEvent now write directly to IDB.
  // useLiveQuery picks up changes automatically — no TanStack cache needed.
  const addEvent = useCallback(
    async (event: StreamEvent) => {
      await db.events.put({ ...event, workspaceId, _sequenceNum: sequenceToNum(event.sequence), _cachedAt: Date.now() })
    },
    [workspaceId]
  )

  const updateEvent = useCallback(async (eventId: string, updates: Partial<StreamEvent>) => {
    await db.events.update(eventId, { ...updates, _cachedAt: Date.now() })
  }, [])

  // Latest sequence from IDB events
  const latestSequence = useMemo(() => {
    if (!idbEvents || idbEvents.length === 0) return bootstrap?.latestSequence ?? "0"
    return idbEvents[idbEvents.length - 1].sequence
  }, [idbEvents, bootstrap?.latestSequence])

  // Aggregated `sharedMessages` hydration entries from every page fetched
  // beyond the bootstrap window — older pages, jump-to results, forward
  // pagination. Bootstrap's own map is merged at the consumer (stream-content)
  // since it lives on a different query. Without this aggregation, pointers
  // in pages older than the bootstrap window render as skeletons even
  // though the backend ships the hydration data on each response.
  const pagedSharedMessages = useMemo<Record<string, SharedMessageHydration>>(() => {
    const merged: Record<string, SharedMessageHydration> = {}
    for (const page of olderData?.pages ?? []) {
      if (page.sharedMessages) Object.assign(merged, page.sharedMessages)
    }
    for (const page of newerData?.pages ?? []) {
      if (page.sharedMessages) Object.assign(merged, page.sharedMessages)
    }
    if (jumpState?.sharedMessages) Object.assign(merged, jumpState.sharedMessages)
    return merged
  }, [olderData, newerData, jumpState])

  return {
    events,
    holes,
    isLoading,
    isConfirmedEmpty,
    error: suppressBootstrapError ? null : error,
    pagedSharedMessages,
    fetchOlderEvents,
    hasOlderEvents,
    isFetchingOlder,
    fetchNewerEvents,
    hasNewerEvents,
    isFetchingNewer,
    jumpToEvent,
    exitJumpMode,
    isJumpMode: !!jumpState,
    addEvent,
    updateEvent,
    latestSequence,
  }
}
