import type { QueryClient } from "@tanstack/react-query"
import type { WorkspaceBootstrap } from "@threa/types"
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
 * Live counter commit: apply one counter mutation to the query cache and IDB
 * immediately. Fire-and-forget, matching socket-handler delivery (the IDB write
 * never blocks the handler).
 */
export function commitCounterMutation(queryClient: QueryClient, workspaceId: string, mutate: CounterMutator): void {
  void writeCounters(queryClient, workspaceId, [mutate])
}

/**
 * Coalesces the counter mutations replayed during one sync catch-up window so
 * the unread / activity badges paint the FINAL value once instead of flickering
 * through every intermediate read/activity the log replays. The counter
 * handlers fold into the ordered mutator list while the gate is paused; `flush`
 * applies the whole fold to the query cache and IDB in a single write when
 * catch-up settles. Buffered live events spliced AFTER the flush apply on top
 * normally — they are genuinely new activity, not replay noise.
 *
 * Atomicity is per-window, not per-entry: the cursor still advances per entry
 * (so a reconnect resumes correctly), and the catch-up handler dispatch order
 * is preserved inside the fold, so LWW activity counts and max-merged ordinals
 * settle on the same value they would have written incrementally.
 */
export class CounterCatchUpBatch {
  private readonly mutators: CounterMutator[] = []

  constructor(
    private readonly queryClient: QueryClient,
    private readonly workspaceId: string
  ) {}

  apply(mutate: CounterMutator): void {
    this.mutators.push(mutate)
  }

  flush(): Promise<void> {
    if (this.mutators.length === 0) return Promise.resolve()
    return writeCounters(this.queryClient, this.workspaceId, this.mutators)
  }
}
