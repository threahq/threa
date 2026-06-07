/**
 * Coordinates the first cached reveal with the background workspace sync so the
 * sync's IndexedDB write doesn't starve the reads that gate that reveal.
 *
 * On a warm start the `CoordinatedLoadingProvider` reads the cached read model
 * from IndexedDB to paint instantly (offline-first). The `SyncEngine`, on its
 * first connect, fetches a fresh workspace bootstrap and writes it back to the
 * same IndexedDB stores. IndexedDB serializes `readwrite` against `readonly` on
 * shared stores, so an un-gated write queues the reveal's reads behind it —
 * which is why an online start lagged an offline one (offline never writes).
 *
 * The fix lets the reveal win the race: the fetch still runs immediately (we do
 * not defer freshness over the wire), but the engine waits for the cached paint
 * before committing the write. Bounded by a timeout so freshness is never
 * indefinitely delayed, and only ever engaged on a warm first connect — a cold
 * start has nothing cached to reveal, and reconnects already have content on
 * screen.
 *
 * INV-9 exception: the per-workspace state lives in a module-level Map by
 * design. The producer (`markInitialRevealComplete`, from a React effect in
 * `CoordinatedLoadingProvider`) and the consumer (`waitForInitialReveal`, in
 * the plain `SyncEngine` class) sit on opposite sides of the React/non-React
 * seam, so a context would have to thread a promise from the gate into the sync
 * engine for no benefit. Keys are globally-unique workspace ULIDs (INV-2), so
 * there is no cross-workspace collision; `resetRevealGate` is wired into
 * `flushModuleStoreCaches` (auth/account-scope.tsx) so an account switch clears
 * it alongside every other module-level store cache.
 */

const REVEAL_TIMEOUT_MS = 2000

interface RevealState {
  revealed: boolean
  promise: Promise<void> | null
  resolve: (() => void) | null
}

const states = new Map<string, RevealState>()

function getState(workspaceId: string): RevealState {
  let state = states.get(workspaceId)
  if (!state) {
    state = { revealed: false, promise: null, resolve: null }
    states.set(workspaceId, state)
  }
  return state
}

/**
 * Signal that the cached content for a workspace has painted. Idempotent —
 * later calls (and re-renders / StrictMode double-mounts) are no-ops.
 */
export function markInitialRevealComplete(workspaceId: string): void {
  const state = getState(workspaceId)
  state.revealed = true
  state.resolve?.()
  state.resolve = null
}

/**
 * Resolve once the cached reveal for a workspace has painted, or after
 * `timeoutMs` — whichever comes first. Resolves immediately if the reveal has
 * already happened.
 */
export function waitForInitialReveal(workspaceId: string, timeoutMs = REVEAL_TIMEOUT_MS): Promise<void> {
  const state = getState(workspaceId)
  if (state.revealed) return Promise.resolve()

  if (!state.promise) {
    state.promise = new Promise<void>((resolve) => {
      state.resolve = resolve
    })
  }
  const revealPromise = state.promise

  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    void revealPromise.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * Clear all reveal state. Called on account switch via `flushModuleStoreCaches`
 * (so a parked account's reveal flags never bleed into the next), and by tests
 * between cases.
 */
export function resetRevealGate(): void {
  states.clear()
}
