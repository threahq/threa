import type { QueryClient } from "@tanstack/react-query"
import type { LastMessagePreview, StreamReadFrontierSnapshot, WorkspaceBootstrap } from "@threa/types"
import { db } from "@/db"
import { getAccountGeneration } from "@/db/event-writes"
import { getPerfCapture } from "@/lib/perf/capture"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { activityKeys } from "@/hooks/use-activity"
import { diffCounterStreams, toCounterState, withCounterState, type UnreadCounterState } from "./unread-counters"
import {
  publishReadAllFrontiersToCache,
  putReadAllFrontiersIdb,
  resolveReadAllFrontiers,
  type ResolvedReadAllFrontier,
} from "./read-state"

/** One absolute (or relative) counter mutation, expressed as pure state math. */
export type CounterMutator = (state: UnreadCounterState) => UnreadCounterState

function fold(mutators: CounterMutator[], seed: UnreadCounterState): UnreadCounterState {
  return mutators.reduce<UnreadCounterState>((state, mutate) => mutate(state), seed)
}

/**
 * Apply a fold of counter mutations to the workspace bootstrap query cache.
 * Folds against the cache's OWN current value (never a captured snapshot), so
 * the per-handler read-merge-write discipline survives — concurrent tabs and a
 * racing local mark-as-read converge instead of clobbering each other (INV-20
 * analogue). A missing cache invalidates rather than dropping (the event landed
 * before the bootstrap queryFn populated it; matches updateBootstrapOrInvalidate).
 */
export function applyCountersToCache(queryClient: QueryClient, workspaceId: string, mutators: CounterMutator[]): void {
  if (mutators.length === 0) return
  const key = workspaceKeys.bootstrap(workspaceId)
  if (queryClient.getQueryData<WorkspaceBootstrap>(key)) {
    queryClient.setQueryData<WorkspaceBootstrap>(key, (old) =>
      old ? withCounterState(old, fold(mutators, toCounterState(old))) : old
    )
  } else {
    queryClient.invalidateQueries({ queryKey: key })
  }
}

/** The bootstrap with the latest preview per stream applied. */
function withPreviews(
  bootstrap: WorkspaceBootstrap,
  previews: Map<string, LastMessagePreview | null>
): WorkspaceBootstrap {
  if (previews.size === 0) return bootstrap
  return {
    ...bootstrap,
    streams: bootstrap.streams.map((stream) =>
      previews.has(stream.id) ? { ...stream, lastMessagePreview: previews.get(stream.id) ?? null } : stream
    ),
  }
}

/** Apply the latest preview per stream to the query cache (drop-on-empty — the
 *  preview is non-critical and the next bootstrap carries it). */
function applyPreviewsToCache(
  queryClient: QueryClient,
  workspaceId: string,
  previews: Map<string, LastMessagePreview | null>
): void {
  if (previews.size === 0) return
  queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) =>
    old ? withPreviews(old, previews) : old
  )
}

/** Fold the counter mutations onto the IDB unread-state singleton. Must run
 *  inside an open `rw` transaction that includes `db.unreadState`. */
export async function putCountersIdb(workspaceId: string, mutators: CounterMutator[]): Promise<void> {
  if (mutators.length === 0) return
  const state = await db.unreadState.get(workspaceId)
  if (!state) return
  // Normalize the held set before folding: a row cached before `unreadActivities`
  // shipped lacks it, and the mutators read it directly.
  const seed = { ...state, unreadActivities: state.unreadActivities ?? [] }
  const folded = fold(mutators, seed)
  const now = Date.now()
  // Stamp per-stream touch times so bootstrap merges know which streams' local
  // state postdates the fetch window (mergeBootstrapUnreadFields).
  const counterTouchedAt = { ...state.counterTouchedAt }
  for (const streamId of diffCounterStreams(seed, folded)) counterTouchedAt[streamId] = now
  await db.unreadState.put({ ...seed, ...folded, counterTouchedAt, _cachedAt: now })
}

/** Write the latest preview per stream to IDB. Must run inside an open `rw`
 *  transaction that includes `db.streams`. */
async function putPreviewsIdb(previews: Map<string, LastMessagePreview | null>): Promise<void> {
  if (previews.size === 0) return
  const now = Date.now()
  for (const [streamId, preview] of previews) {
    await db.streams.update(streamId, { lastMessagePreview: preview, _cachedAt: now })
  }
}

/**
 * Live counter commit: apply one counter mutation to the query cache and IDB
 * immediately. Fire-and-forget, matching socket-handler delivery (the IDB write
 * never blocks the handler).
 */
export function commitCounterMutation(queryClient: QueryClient, workspaceId: string, mutate: CounterMutator): void {
  const mutators = [mutate]
  applyCountersToCache(queryClient, workspaceId, mutators)
  getPerfCapture().count("stream.idbTransaction")
  void db.transaction("rw", [db.unreadState], () => putCountersIdb(workspaceId, mutators))
}

/** Live preview commit for a single stream (fire-and-forget). */
export function commitStreamPreview(
  queryClient: QueryClient,
  workspaceId: string,
  streamId: string,
  preview: LastMessagePreview | null
): void {
  const previews = new Map([[streamId, preview]])
  applyPreviewsToCache(queryClient, workspaceId, previews)
  getPerfCapture().count("stream.idbTransaction")
  void db.transaction("rw", [db.streams], () => putPreviewsIdb(previews))
}

/**
 * Coalesces the counter and preview writes of ONE task's live events into a
 * single IDB transaction and a single bootstrap-cache replacement, through the
 * same helpers `CatchUpBatch` folds with. One `stream:activity` otherwise costs
 * two transactions and two whole-`streams`-array rebuilds; a burst costs two per
 * message.
 *
 * The flush is a `queueMicrotask`, never a timer or a frame, so the badge and
 * the sidebar still settle inside the task that delivered the events.
 *
 * Order is persist-then-publish, matching {@link CatchUpBatch.flush}: the caches
 * never publish state the IDB lacks, so a failed flush publishes nothing at all
 * rather than half of a fold.
 */
export class LiveCommitBatch {
  private counterMutators: CounterMutator[] = []
  private streamPreviews = new Map<string, LastMessagePreview | null>()
  private readAllSnapshots: StreamReadFrontierSnapshot[] = []
  private scheduled = false
  private destroyed = false
  /** The account this batch belongs to. `db` is a proxy repointed on an account
   *  switch, so a flush resolving after one would write these rows into the
   *  other account's database. */
  private readonly accountGeneration = getAccountGeneration()
  /** Latches the engine reseed request until a flush succeeds. */
  private reseedRequested = false
  /** Flushes run one at a time and in schedule order, so an awaited `flush()`
   *  drains everything buffered before it (the catch-up window's guarantee). */
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly queryClient: QueryClient,
    private readonly workspaceId: string,
    /** Invoked when a flush's transaction rejects and its fold is dropped. The
     *  engine owns the recovery (a forced full snapshot reseed): a dropped
     *  `upsertActivity` is a held-set insert, so it cannot self-heal from the
     *  next message the way an absolute ordinal mutator does. */
    private readonly onFlushFailed?: () => void
  ) {}

  applyCounter(mutate: CounterMutator): void {
    if (this.destroyed) return
    this.counterMutators.push(mutate)
    this.schedule()
  }

  setStreamPreview(streamId: string, preview: LastMessagePreview | null): void {
    if (this.destroyed) return
    this.streamPreviews.set(streamId, preview)
    this.schedule()
  }

  /** Buffer one read-all payload's additive frontier snapshots, resolved and
   *  persisted at flush time inside the same transaction as the counter fold —
   *  the live mirror of {@link CatchUpBatch.applyReadAllFrontiers}. The counter
   *  half arrives through {@link applyCounter}, so a read-all and the activity
   *  that preceded it fold in DELIVERY order: routing read-all around this
   *  buffer would let its drop-held-rows transaction open at handler time and
   *  run BEFORE the fold that inserts the held activity, resurrecting a mention
   *  the user already read. */
  applyReadAllFrontiers(frontiers: StreamReadFrontierSnapshot[] | undefined): void {
    if (this.destroyed || !frontiers || frontiers.length === 0) return
    this.readAllSnapshots.push(...frontiers)
    this.schedule()
  }

  /** Whether anything is buffered and not yet committed. Callers taking the
   *  immediate path (the flag flipped off mid-task) drain first, so a pending
   *  fold can't land on top of a newer immediate commit. */
  hasPending(): boolean {
    return this.counterMutators.length > 0 || this.streamPreviews.size > 0 || this.readAllSnapshots.length > 0
  }

  /** Commit everything buffered so far. Awaited by the engine when a catch-up
   *  window opens, so a live fold can never interleave into a replay fold. */
  flush(): Promise<void> {
    this.scheduled = false
    const attempt = this.chain.then(() => this.commit())
    // The chain carries the swallowed copy: `.then(onFulfilled)` on a rejected
    // promise skips its callback and propagates, so one rejection (a mutator
    // throwing inside publish) would poison every later flush permanently.
    this.chain = attempt.catch((error) => {
      console.error("Live commit batch flush failed", { workspaceId: this.workspaceId, error })
    })
    return attempt
  }

  /** Stop writing on behalf of a torn-down workspace: a flush already scheduled
   *  runs as a no-op rather than persisting against a repointed database. */
  destroy(): void {
    this.destroyed = true
    this.counterMutators = []
    this.streamPreviews.clear()
    this.readAllSnapshots = []
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      if (!this.scheduled) return
      // The chain logs it; this only keeps the fire-and-forget copy handled.
      void this.flush().catch(() => {})
    })
  }

  private async commit(): Promise<void> {
    const mutators = this.counterMutators
    const previews = this.streamPreviews
    const snapshots = this.readAllSnapshots
    this.counterMutators = []
    this.streamPreviews = new Map()
    this.readAllSnapshots = []
    if (this.destroyed) return
    if (getAccountGeneration() !== this.accountGeneration) return
    if (mutators.length === 0 && previews.size === 0 && snapshots.length === 0) return

    // Its OWN mark, never the handler's: the handler-body `stream.activityApply`
    // fires per event in both arms, so folding this sample into that name would
    // mix an N-sample buffer-push population with one persist-and-publish sample
    // and make the arms unreadable.
    const stopFold = getPerfCapture().time("stream.liveCommitFold")
    const haveFrontiers = snapshots.length > 0
    let resolved: ResolvedReadAllFrontier[] = []
    try {
      getPerfCapture().count("stream.idbTransaction")
      await db.transaction(
        "rw",
        haveFrontiers ? [db.streams, db.unreadState, db.streamReadState] : [db.streams, db.unreadState],
        async () => {
          await putCountersIdb(this.workspaceId, mutators)
          await putPreviewsIdb(previews)
          if (haveFrontiers) {
            resolved = await resolveReadAllFrontiers(this.queryClient, this.workspaceId, snapshots)
            await putReadAllFrontiersIdb(this.workspaceId, resolved)
          }
        }
      )
    } catch (error) {
      stopFold()
      this.reportFailure(error, mutators.length > 0)
      return
    }

    try {
      if (this.destroyed) return
      if (getAccountGeneration() !== this.accountGeneration) return
      this.publish(mutators, previews)
      publishReadAllFrontiersToCache(this.queryClient, this.workspaceId, resolved)
      this.reseedRequested = false
    } catch (error) {
      // A publish failure drops the fold just as a transaction failure does, and
      // a held-set `upsertActivity` cannot self-heal from the next event — so it
      // takes the same one-shot reseed rather than being left as a residual.
      this.reportFailure(error, mutators.length > 0)
    } finally {
      stopFold()
    }
  }

  /** One-shot reseed latch: a persistently failing IDB would otherwise turn
   *  every message into a forced full bootstrap, each of which fails the same
   *  way. Only a dropped counter fold needs it — a dropped preview is
   *  non-critical and the next bootstrap carries it. */
  private reportFailure(error: unknown, hadCounters: boolean): void {
    console.error("Live commit batch flush failed", { workspaceId: this.workspaceId, error })
    if (hadCounters && !this.reseedRequested) {
      this.reseedRequested = true
      this.onFlushFailed?.()
    }
  }

  /** One bootstrap replacement for the whole fold. Falls back to the helpers
   *  when the bootstrap isn't cached, so the counter path still invalidates
   *  (the event landed before the queryFn populated it) and the preview path
   *  still drops. */
  private publish(mutators: CounterMutator[], previews: Map<string, LastMessagePreview | null>): void {
    const key = workspaceKeys.bootstrap(this.workspaceId)
    if (!this.queryClient.getQueryData<WorkspaceBootstrap>(key)) {
      applyCountersToCache(this.queryClient, this.workspaceId, mutators)
      applyPreviewsToCache(this.queryClient, this.workspaceId, previews)
      return
    }
    this.queryClient.setQueryData<WorkspaceBootstrap>(key, (old) => {
      if (!old) return old
      const counted = mutators.length === 0 ? old : withCounterState(old, fold(mutators, toCounterState(old)))
      return withPreviews(counted, previews)
    })
  }
}

/**
 * Coalesces the sidebar/badge state mutated during one sync catch-up window so
 * it paints the FINAL value once instead of flickering through every replayed
 * entry. Three flickering surfaces fold in here while the gate is paused:
 *
 * - Unread / activity counters (`applyCounter`) — interleaved read/activity
 *   entries otherwise bounce the badge up and down as it pages.
 * - Stream last-message previews (`setStreamPreview`, last write wins per
 *   stream) — each per-entry write re-sorts the activity-ordered sidebar, so
 *   streams visibly jump around mid catch-up.
 * - The activity feed query (`markActivityFeedStale`) — otherwise re-invalidated
 *   (and refetched) per entry while the badge sits frozen until flush.
 *
 * `flush` commits counters and previews in ONE IDB transaction (so the badge's
 * `db.unreadState` and the sidebar's `db.streams` `useLiveQuery` observers fire
 * together — no cross-surface frame gap) and invalidates the feed once. Buffered
 * live events spliced AFTER the flush apply on top normally — they are genuinely
 * new activity, not replay noise.
 *
 * Atomicity is per-window, not per-entry: the cursor still advances per entry
 * (so a reconnect resumes correctly), and the catch-up dispatch order is
 * preserved inside the fold / last-wins map, so the result equals what the
 * incremental writes would have settled on.
 */
export class CatchUpBatch {
  private readonly counterMutators: CounterMutator[] = []
  private readonly streamPreviews = new Map<string, LastMessagePreview | null>()
  private readonly readAllSnapshots: StreamReadFrontierSnapshot[] = []
  private activityFeedStale = false

  constructor(
    private readonly queryClient: QueryClient,
    private readonly workspaceId: string
  ) {}

  applyCounter(mutate: CounterMutator): void {
    this.counterMutators.push(mutate)
  }

  setStreamPreview(streamId: string, preview: LastMessagePreview | null): void {
    this.streamPreviews.set(streamId, preview)
  }

  /** Buffer one read-all payload's additive frontier snapshots. Resolution
   *  against the persisted rows happens at flush time — inside the flush
   *  transaction — so the canonical frontier rows persist atomically with the
   *  counter fold (and a concurrent advance can't slip between resolve and
   *  write). Legacy payloads without frontiers buffer nothing. */
  applyReadAllFrontiers(frontiers: StreamReadFrontierSnapshot[] | undefined): void {
    if (!frontiers || frontiers.length === 0) return
    this.readAllSnapshots.push(...frontiers)
  }

  markActivityFeedStale(): void {
    this.activityFeedStale = true
  }

  async flush(): Promise<void> {
    const haveCounters = this.counterMutators.length > 0
    const havePreviews = this.streamPreviews.size > 0
    const haveFrontiers = this.readAllSnapshots.length > 0

    let resolvedFrontiers: ResolvedReadAllFrontier[] = []
    if (haveCounters || havePreviews || haveFrontiers) {
      // One transaction over every table the replay touched so the badge
      // (db.unreadState), the sidebar (db.streams), and the divider
      // (db.streamReadState) re-render together — never one frame apart — and a
      // failed flush never leaves a partial write behind.
      await db.transaction(
        "rw",
        haveFrontiers ? [db.unreadState, db.streams, db.streamReadState] : [db.unreadState, db.streams],
        async () => {
          await putCountersIdb(this.workspaceId, this.counterMutators)
          await putPreviewsIdb(this.streamPreviews)
          if (haveFrontiers) {
            resolvedFrontiers = await resolveReadAllFrontiers(this.queryClient, this.workspaceId, this.readAllSnapshots)
            await putReadAllFrontiersIdb(this.workspaceId, resolvedFrontiers)
          }
        }
      )
    }

    // In-memory publication only after successful persistence, so the caches
    // never publish state the IDB lacks.
    applyCountersToCache(this.queryClient, this.workspaceId, this.counterMutators)
    applyPreviewsToCache(this.queryClient, this.workspaceId, this.streamPreviews)
    publishReadAllFrontiersToCache(this.queryClient, this.workspaceId, resolvedFrontiers)

    if (this.activityFeedStale) {
      this.queryClient.invalidateQueries({ queryKey: activityKeys.list(this.workspaceId) })
    }
  }
}
