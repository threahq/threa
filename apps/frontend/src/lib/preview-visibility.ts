/**
 * Batches "these provider preview cards are on screen" reports into periodic
 * `previews:visible` socket frames. The backend uses them to run conditional
 * (ETag-gated) refreshes for repos webhooks can't reach, so cadence here is
 * deliberately lazy: one frame per flush interval covering everything visible,
 * nothing while the tab is hidden, and the server debounces per preview anyway.
 */

export const PREVIEW_VISIBILITY_FLUSH_MS = 10_000
/** First flush after the viewport goes from empty to occupied — batches the initial mount burst. */
const LEADING_FLUSH_MS = 1_000

type Emitter = (workspaceId: string, previewIds: string[]) => void

const visibleByWorkspace = new Map<string, Set<string>>()
let emitter: Emitter | null = null
let intervalId: ReturnType<typeof setInterval> | null = null
let leadingId: ReturnType<typeof setTimeout> | null = null

/** Wired by the socket provider; null while disconnected (reports keep accumulating). */
export function setPreviewVisibilityEmitter(next: Emitter | null): void {
  emitter = next
  syncTimer()
}

export function reportPreviewVisible(workspaceId: string, previewId: string): void {
  const hadAny = visibleByWorkspace.size > 0
  let set = visibleByWorkspace.get(workspaceId)
  if (!set) {
    set = new Set()
    visibleByWorkspace.set(workspaceId, set)
  }
  set.add(previewId)
  if (!hadAny && leadingId === null) {
    leadingId = setTimeout(() => {
      leadingId = null
      flush()
    }, LEADING_FLUSH_MS)
  }
  syncTimer()
}

export function reportPreviewHidden(workspaceId: string, previewId: string): void {
  const set = visibleByWorkspace.get(workspaceId)
  if (!set) return
  set.delete(previewId)
  if (set.size === 0) visibleByWorkspace.delete(workspaceId)
  syncTimer()
}

/** Test-only: runs one flush synchronously instead of waiting out the interval. */
export function flushPreviewVisibilityForTest(): void {
  flush()
}

/** Test-only: clears accumulated state and timers between cases. */
export function resetPreviewVisibility(): void {
  visibleByWorkspace.clear()
  emitter = null
  if (leadingId !== null) {
    clearTimeout(leadingId)
    leadingId = null
  }
  syncTimer()
}

function syncTimer(): void {
  const shouldRun = emitter !== null && visibleByWorkspace.size > 0
  if (shouldRun && intervalId === null) {
    intervalId = setInterval(flush, PREVIEW_VISIBILITY_FLUSH_MS)
  } else if (!shouldRun && intervalId !== null) {
    clearInterval(intervalId)
    intervalId = null
  }
}

function flush(): void {
  if (!emitter) return
  // A hidden tab keeps observing (sets stay warm for the return) but must not
  // nudge the server about cards nobody is looking at.
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return
  for (const [workspaceId, ids] of visibleByWorkspace) {
    if (ids.size > 0) emitter(workspaceId, [...ids])
  }
}
