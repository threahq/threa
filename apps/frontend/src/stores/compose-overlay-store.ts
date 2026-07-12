import { useSyncExternalStore } from "react"

// The single app-level board authoring overlay: one instance is mounted in the
// workspace layout, and every entry point (the board "Write a post" button, the
// quick-switcher "New post" command) toggles it through this store rather than
// mounting its own copy — two mounts would share the draft but diverge on target
// and could open two dialogs at once.

interface ComposeOverlayState {
  open: boolean
  /** A stream id / `new:*` sentinel to open on, if the entry point specified one. */
  defaultTarget?: string
}

let state: ComposeOverlayState = { open: false }
const listeners = new Set<() => void>()

// The board registers what should happen after a successful post (reveal the new
// card / bounce the lens). It's a plain ref, not reactive state: the mount reads
// it imperatively when a post lands. Undefined when the board isn't mounted, so a
// post from a non-board surface simply lands (its "N new" pill surfaces it later).
let onPostedRef: (() => void) | undefined

function emit(): void {
  for (const listener of listeners) listener()
}

/** Open the overlay, optionally pre-selecting a target. */
export function openCompose(defaultTarget?: string): void {
  state = { open: true, defaultTarget }
  emit()
}

export function closeCompose(): void {
  if (!state.open) return
  state = { open: false }
  emit()
}

/** Register the post-success handler (the board does this while mounted). */
export function registerComposeOnPosted(onPosted: () => void): () => void {
  onPostedRef = onPosted
  return () => {
    if (onPostedRef === onPosted) onPostedRef = undefined
  }
}

/** Invoke the registered post-success handler, if any. Called by the mount. */
export function notifyComposePosted(): void {
  onPostedRef?.()
}

/**
 * Clear the module state on account switch — like every sibling store — so a
 * prior account's open overlay / target can't bleed into the next (account-scope
 * `flushModuleStoreCaches`).
 */
export function resetComposeOverlayStoreCache(): void {
  state = { open: false }
  onPostedRef = undefined
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useComposeOverlay(): ComposeOverlayState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state
  )
}
