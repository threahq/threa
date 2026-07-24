import type { QueryClient } from "@tanstack/react-query"
import type { LastMessagePreview, StreamReadFrontierSnapshot, WorkspaceBootstrap } from "@threa/types"
import { db } from "@/db"
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

/** Apply the latest preview per stream to the query cache (drop-on-empty — the
 *  preview is non-critical and the next bootstrap carries it). */
function applyPreviewsToCache(
  queryClient: QueryClient,
  workspaceId: string,
  previews: Map<string, LastMessagePreview | null>
): void {
  if (previews.size === 0) return
  queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) =>
    old
      ? {
          ...old,
          streams: old.streams.map((stream) =>
            previews.has(stream.id) ? { ...stream, lastMessagePreview: previews.get(stream.id) ?? null } : stream
          ),
        }
      : old
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
  void db.transaction("rw", [db.streams], () => putPreviewsIdb(previews))
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
