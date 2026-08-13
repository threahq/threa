import { createContext, useContext } from "react"

export interface ReadCommitMark {
  lastEventId: string
  partial: boolean
}

export const READ_COMMIT_DEBOUNCE_MS = 500

interface PendingMark extends ReadCommitMark {
  timer: ReturnType<typeof setTimeout>
}

/**
 * The one owner of the OUTBOUND read-commit pipeline for a workspace: view
 * components observe what was painted (the read frontier) and `report` it
 * here; this queue owns everything that used to live in component effect
 * lifecycle — debouncing, newest-wins coalescing per stream, flush on leave,
 * flush-all on pagehide, and the committed-mark dedup record. Teardown
 * semantics were read-loss semantics twice (#1881: the fling and glance-triage
 * bugs) precisely because the commit pipeline lived inside React effects; a
 * mark that the frontier has counted as seen must survive whatever the
 * component tree does next.
 *
 * Constructed per workspace by the workspace layout (the SyncEngine pattern)
 * and provided via `ReadCommitQueueContext`. The commit dependency is read
 * through `commitRef` at fire time so the layout can keep it fresh across
 * renders without reconstructing the queue — and so a queue being disposed at
 * workspace switch still flushes through the OLD workspace's commit.
 *
 * Semantics preserved from the hook era:
 * - `report` (re)arms a trailing debounce; a newer report replaces the pending
 *   mark and resets the timer.
 * - `cancel` drops the pending mark without committing (the attention gate
 *   closing — blur — keeps its cancel semantics; content seen just before a
 *   blur stays unread rather than over-marking).
 * - `flush` commits the pending mark immediately (stream switch, unmount).
 * - A fired or flushed mark is recorded in `lastCommitted` for the caller's
 *   dedup; `resetCommitted` clears it on a fresh stream open so the
 *   caught-up-open heal (D5) still fires once per open.
 */
export class ReadCommitQueue {
  readonly workspaceId: string
  readonly commitRef: { current: (streamId: string, lastEventId: string, opts: { partial: boolean }) => void }
  private readonly debounceMs: number
  private readonly pending = new Map<string, PendingMark>()
  private readonly committed = new Map<string, ReadCommitMark>()
  private disposed = false
  // Leaving the page entirely (navigation away, tab close, mobile app kill)
  // gives no effect cleanup a chance to run — commit whatever is pending.
  // Best-effort: the request is a normal fetch, so an unload racing it can
  // still drop it, but that is strictly better than the guaranteed drop a
  // cancelled timer was.
  private readonly onPageHide = () => this.flushAll()

  constructor(deps: {
    workspaceId: string
    commitRef: { current: (streamId: string, lastEventId: string, opts: { partial: boolean }) => void }
    debounceMs?: number
  }) {
    this.workspaceId = deps.workspaceId
    this.commitRef = deps.commitRef
    this.debounceMs = deps.debounceMs ?? READ_COMMIT_DEBOUNCE_MS
    window.addEventListener("pagehide", this.onPageHide)
  }

  report(streamId: string, lastEventId: string, partial: boolean): void {
    if (this.disposed) return
    const existing = this.pending.get(streamId)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      const mark = this.pending.get(streamId)
      if (!mark) return
      this.pending.delete(streamId)
      this.send(streamId, mark)
    }, this.debounceMs)
    this.pending.set(streamId, { lastEventId, partial, timer })
  }

  cancel(streamId: string): void {
    const mark = this.pending.get(streamId)
    if (!mark) return
    clearTimeout(mark.timer)
    this.pending.delete(streamId)
  }

  flush(streamId: string): void {
    const mark = this.pending.get(streamId)
    if (!mark) return
    clearTimeout(mark.timer)
    this.pending.delete(streamId)
    this.send(streamId, mark)
  }

  flushAll(): void {
    for (const streamId of [...this.pending.keys()]) this.flush(streamId)
  }

  /** The last mark actually sent for this stream — pending/cancelled marks
   *  never appear here, so a blur-cancelled mark re-reports after refocus. */
  lastCommitted(streamId: string): ReadCommitMark | null {
    return this.committed.get(streamId) ?? null
  }

  /** A fresh open of the stream forgets the committed record so the once-per-
   *  open caught-up heal can fire again. */
  resetCommitted(streamId: string): void {
    this.committed.delete(streamId)
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** Detach immediately, commit what was pending a microtask later. Called on
   *  workspace switch — which happens during the owner's RENDER (the
   *  SyncEngine-style recreate check), where running the commit's cache writes
   *  would be a render-phase side effect — and on layout unmount. The captured
   *  marks still send through this queue's own commitRef, so a switch flushes
   *  into the outgoing workspace. The owner recreates on the next render if it
   *  finds a disposed queue in its ref (StrictMode's mount→cleanup→remount
   *  cycle). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener("pagehide", this.onPageHide)
    const marks = [...this.pending.entries()]
    this.pending.clear()
    for (const [, mark] of marks) clearTimeout(mark.timer)
    if (marks.length === 0) return
    queueMicrotask(() => {
      for (const [streamId, mark] of marks) this.send(streamId, mark)
    })
  }

  private send(streamId: string, mark: ReadCommitMark): void {
    this.committed.set(streamId, { lastEventId: mark.lastEventId, partial: mark.partial })
    this.commitRef.current(streamId, mark.lastEventId, { partial: mark.partial })
  }
}

export const ReadCommitQueueContext = createContext<ReadCommitQueue | null>(null)

export function useReadCommitQueue(): ReadCommitQueue {
  const queue = useContext(ReadCommitQueueContext)
  if (!queue) throw new Error("useReadCommitQueue must be used within a ReadCommitQueueContext provider")
  return queue
}
