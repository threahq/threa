import type { QueryClient } from "@tanstack/react-query"
import type { LastMessagePreview, WorkspaceBootstrap } from "@threa/types"
import { db } from "@/db"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { toCounterState, withCounterState, type UnreadCounterState } from "./unread-counters"

/** One absolute (or relative) counter mutation, expressed as pure state math. */
export type CounterMutator = (state: UnreadCounterState) => UnreadCounterState

function fold(mutators: CounterMutator[], seed: UnreadCounterState): UnreadCounterState {
  return mutators.reduce<UnreadCounterState>((state, mutate) => mutate(state), seed)
}

/**
 * Apply a fold of counter mutations to BOTH reactive surfaces the badges read:
 * the workspace bootstrap query cache and the IDB unread-state singleton. Each
 * surface folds against its OWN current value (never a captured snapshot), so
 * the per-handler read-merge-write discipline survives — concurrent tabs and a
 * racing local mark-as-read converge instead of clobbering each other (INV-20
 * analogue).
 */
async function writeCounters(queryClient: QueryClient, workspaceId: string, mutators: CounterMutator[]): Promise<void> {
  if (mutators.length === 0) return
  const key = workspaceKeys.bootstrap(workspaceId)
  if (queryClient.getQueryData<WorkspaceBootstrap>(key)) {
    queryClient.setQueryData<WorkspaceBootstrap>(key, (old) =>
      old ? withCounterState(old, fold(mutators, toCounterState(old))) : old
    )
  } else {
    // The event/replay landed before the bootstrap queryFn populated the cache;
    // a plain set would silently drop it. Invalidate so the refetch picks the
    // counts up from the server snapshot (matches updateBootstrapOrInvalidate).
    queryClient.invalidateQueries({ queryKey: key })
  }
  await db.transaction("rw", [db.unreadState], async () => {
    const state = await db.unreadState.get(workspaceId)
    if (!state) return
    await db.unreadState.put({ ...state, ...fold(mutators, state), _cachedAt: Date.now() })
  })
}

/**
 * Write the latest message preview for each touched stream to the query cache
 * and IDB. One IDB transaction for the whole set, so the sidebar's `useLiveQuery`
 * re-sorts ONCE on the final order rather than per stream. A missing query-cache
 * bootstrap is a no-op (drop-on-empty) — the preview is non-critical and the next
 * bootstrap carries it; only the counter path invalidates on empty.
 */
async function writeStreamPreviews(
  queryClient: QueryClient,
  workspaceId: string,
  previews: Map<string, LastMessagePreview | null>
): Promise<void> {
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
  const now = Date.now()
  await db.transaction("rw", [db.streams], async () => {
    for (const [streamId, preview] of previews) {
      await db.streams.update(streamId, { lastMessagePreview: preview, _cachedAt: now })
    }
  })
}

/**
 * Live counter commit: apply one counter mutation to the query cache and IDB
 * immediately. Fire-and-forget, matching socket-handler delivery (the IDB write
 * never blocks the handler).
 */
export function commitCounterMutation(queryClient: QueryClient, workspaceId: string, mutate: CounterMutator): void {
  void writeCounters(queryClient, workspaceId, [mutate])
}

/** Live preview commit for a single stream (fire-and-forget). */
export function commitStreamPreview(
  queryClient: QueryClient,
  workspaceId: string,
  streamId: string,
  preview: LastMessagePreview | null
): void {
  void writeStreamPreviews(queryClient, workspaceId, new Map([[streamId, preview]]))
}

/**
 * Coalesces the sidebar/badge state mutated during one sync catch-up window so
 * it paints the FINAL value once instead of flickering through every replayed
 * entry. Two flickering surfaces fold in here while the gate is paused:
 *
 * - Unread / activity counters (`applyCounter`) — interleaved read/activity
 *   entries otherwise bounce the badge up and down as it pages.
 * - Stream last-message previews (`setStreamPreview`, last write wins per
 *   stream) — each per-entry write re-sorts the activity-ordered sidebar, so
 *   streams visibly jump around mid catch-up.
 *
 * `flush` commits both in one query-cache update + one IDB transaction each when
 * catch-up settles. Buffered live events spliced AFTER the flush apply on top
 * normally — they are genuinely new activity, not replay noise.
 *
 * Atomicity is per-window, not per-entry: the cursor still advances per entry
 * (so a reconnect resumes correctly), and the catch-up dispatch order is
 * preserved inside the fold / last-wins map, so the result equals what the
 * incremental writes would have settled on.
 */
export class CatchUpBatch {
  private readonly counterMutators: CounterMutator[] = []
  private readonly streamPreviews = new Map<string, LastMessagePreview | null>()

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

  async flush(): Promise<void> {
    await writeCounters(this.queryClient, this.workspaceId, this.counterMutators)
    await writeStreamPreviews(this.queryClient, this.workspaceId, this.streamPreviews)
  }
}
