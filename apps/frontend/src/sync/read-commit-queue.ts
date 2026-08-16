import { createContext, useContext } from "react"

export interface ReadCommitMark {
  lastEventId: string
  partial: boolean
}

export const READ_COMMIT_DEBOUNCE_MS = 500
export const READ_COMMIT_RETRY_MS = 1_000
export const READ_COMMIT_MAX_RETRIES = 3
export const READ_COMMIT_PARKED_RETRY_MS = 30_000

type CommitRead = (streamId: string, lastEventId: string, opts: { partial: boolean }) => Promise<void>

interface ScheduledMark extends ReadCommitMark {
  timer: ReturnType<typeof setTimeout>
  attempt: number
}

interface QueuedMark extends ReadCommitMark {
  attempt: number
}

interface ExplicitUnread {
  initialReadEventId: string | null | undefined
  observedReadEventIds: Set<string | null | undefined>
  expectedReadEventId: string | null | undefined
  operationDone: boolean
  postOperationPointerChanged: boolean
}

/**
 * Workspace-scoped owner of outbound read commits. A mark becomes committed
 * only after the request and its local reconciliation succeed. Failed requests
 * retry here rather than depending on a React render to report the same
 * frontier again.
 */
export class ReadCommitQueue {
  readonly workspaceId: string
  readonly commitRef: { current: CommitRead }
  private readonly debounceMs: number
  private readonly pending = new Map<string, ScheduledMark>()
  private readonly queued = new Map<string, QueuedMark>()
  private readonly failed = new Map<string, ReadCommitMark>()
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly committed = new Map<string, ReadCommitMark>()
  private readonly explicitUnread = new Map<string, ExplicitUnread>()
  private readonly explicitUnreadTail = new Map<string, Promise<void>>()
  private readonly draining = new Set<string>()
  private disposed = false

  private readonly onPageHide = () => this.flushAll()
  private readonly onWake = () => {
    if (document.visibilityState === "hidden") return
    for (const [streamId, mark] of this.failed) {
      const scheduled = this.pending.get(streamId)
      if (scheduled) clearTimeout(scheduled.timer)
      this.pending.delete(streamId)
      this.failed.delete(streamId)
      this.dispatch(streamId, { ...mark, attempt: 0 })
    }
  }

  constructor(deps: { workspaceId: string; commitRef: { current: CommitRead }; debounceMs?: number }) {
    this.workspaceId = deps.workspaceId
    this.commitRef = deps.commitRef
    this.debounceMs = deps.debounceMs ?? READ_COMMIT_DEBOUNCE_MS
    window.addEventListener("pagehide", this.onPageHide)
    window.addEventListener("online", this.onWake)
    window.addEventListener("focus", this.onWake)
    document.addEventListener("visibilitychange", this.onWake)
  }

  report(streamId: string, lastEventId: string, partial: boolean): void {
    if (this.disposed || this.hasExplicitUnread(streamId)) return
    this.failed.delete(streamId)
    this.schedule(streamId, { lastEventId, partial }, 0, this.debounceMs)
  }

  cancel(streamId: string): void {
    const mark = this.pending.get(streamId)
    if (mark) clearTimeout(mark.timer)
    this.pending.delete(streamId)
    this.queued.delete(streamId)
    this.failed.delete(streamId)
  }

  flush(streamId: string): void {
    const mark = this.pending.get(streamId)
    if (!mark) return
    clearTimeout(mark.timer)
    this.pending.delete(streamId)
    this.dispatch(streamId, mark)
  }

  flushAll(): void {
    for (const streamId of [...this.pending.keys()]) this.flush(streamId)
  }

  lastCommitted(streamId: string): ReadCommitMark | null {
    return this.committed.get(streamId) ?? null
  }

  resetCommitted(streamId: string): void {
    this.committed.delete(streamId)
  }

  /**
   * Serialize an explicit unread behind any older read request, then hold new
   * read reports until the operation's locally reconciled pointer is observed.
   */
  async runExplicitUnread(
    streamId: string,
    initialReadEventId: string | null | undefined,
    operation: () => Promise<string | null | undefined>
  ): Promise<void> {
    this.cancel(streamId)
    const previous = this.explicitUnreadTail.get(streamId)
    const start = () => this.executeExplicitUnread(streamId, initialReadEventId, operation)
    const current = previous ? previous.then(start, start) : start()
    this.explicitUnreadTail.set(streamId, current)
    try {
      await current
    } finally {
      if (this.explicitUnreadTail.get(streamId) === current) this.explicitUnreadTail.delete(streamId)
    }
  }

  observeReadPointer(streamId: string, readEventId: string | null | undefined): void {
    const state = this.explicitUnread.get(streamId)
    if (!state) return
    state.observedReadEventIds.add(readEventId)
    if (state.operationDone && readEventId !== undefined && readEventId !== state.initialReadEventId) {
      state.postOperationPointerChanged = true
    }
    this.releaseExplicitUnreadIfReady(streamId, state)
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener("pagehide", this.onPageHide)
    window.removeEventListener("online", this.onWake)
    window.removeEventListener("focus", this.onWake)
    document.removeEventListener("visibilitychange", this.onWake)
    const marks = [...this.pending.entries()]
    this.pending.clear()
    for (const [, mark] of marks) clearTimeout(mark.timer)
    for (const streamId of new Set([...this.inFlight.keys(), ...this.queued.keys(), ...marks.map(([id]) => id)])) {
      this.draining.add(streamId)
    }
    if (marks.length > 0) {
      queueMicrotask(() => {
        for (const [streamId, mark] of marks) this.dispatch(streamId, mark, true)
      })
    }
  }

  private schedule(streamId: string, mark: ReadCommitMark, attempt: number, delay: number): void {
    const existing = this.pending.get(streamId)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      const scheduled = this.pending.get(streamId)
      if (!scheduled) return
      this.pending.delete(streamId)
      this.dispatch(streamId, scheduled)
    }, delay)
    this.pending.set(streamId, { ...mark, attempt, timer })
  }

  private dispatch(streamId: string, mark: QueuedMark, allowDisposed = false): void {
    const canDrain = allowDisposed || this.draining.has(streamId)
    if ((!canDrain && this.disposed) || this.hasExplicitUnread(streamId)) return
    if (this.inFlight.has(streamId)) {
      this.queued.set(streamId, mark)
      return
    }

    const promise = this.execute(streamId, mark, canDrain)
    this.inFlight.set(streamId, promise)
  }

  private async execute(streamId: string, mark: QueuedMark, allowDisposed: boolean): Promise<void> {
    try {
      let operation: Promise<void>
      try {
        operation = this.commitRef.current(streamId, mark.lastEventId, { partial: mark.partial })
      } catch (error) {
        operation = Promise.reject(error)
      }
      await operation
      this.committed.set(streamId, { lastEventId: mark.lastEventId, partial: mark.partial })
      this.failed.delete(streamId)
    } catch {
      const newerMarkExists = this.pending.has(streamId) || this.queued.has(streamId)
      const canRetry = !this.disposed || allowDisposed || this.draining.has(streamId)
      if (!newerMarkExists && !this.hasExplicitUnread(streamId) && canRetry) {
        if (mark.attempt < READ_COMMIT_MAX_RETRIES) {
          this.schedule(streamId, mark, mark.attempt + 1, READ_COMMIT_RETRY_MS * 2 ** mark.attempt)
        } else if (!this.disposed) {
          this.failed.set(streamId, { lastEventId: mark.lastEventId, partial: mark.partial })
          this.schedule(streamId, mark, READ_COMMIT_MAX_RETRIES, READ_COMMIT_PARKED_RETRY_MS)
        }
      }
    } finally {
      this.inFlight.delete(streamId)
      const next = this.queued.get(streamId)
      if (next) {
        this.queued.delete(streamId)
        this.dispatch(streamId, next, allowDisposed)
      } else if (!this.pending.has(streamId)) {
        this.draining.delete(streamId)
      }
    }
  }

  private hasExplicitUnread(streamId: string): boolean {
    return this.explicitUnread.has(streamId) || this.explicitUnreadTail.has(streamId)
  }

  private async executeExplicitUnread(
    streamId: string,
    initialReadEventId: string | null | undefined,
    operation: () => Promise<string | null | undefined>
  ): Promise<void> {
    const state: ExplicitUnread = {
      initialReadEventId,
      observedReadEventIds: new Set([initialReadEventId]),
      expectedReadEventId: undefined,
      operationDone: false,
      postOperationPointerChanged: false,
    }
    this.explicitUnread.set(streamId, state)
    const inFlight = this.inFlight.get(streamId)
    if (inFlight) await inFlight
    try {
      state.expectedReadEventId = await operation()
      state.operationDone = true
      this.releaseExplicitUnreadIfReady(streamId, state)
    } catch (error) {
      if (this.explicitUnread.get(streamId) === state) this.explicitUnread.delete(streamId)
      throw error
    }
  }

  private releaseExplicitUnreadIfReady(streamId: string, state: ExplicitUnread): void {
    if (!state.operationDone || this.explicitUnread.get(streamId) !== state) return
    const pointerMatches =
      state.postOperationPointerChanged ||
      (state.expectedReadEventId !== undefined
        ? state.observedReadEventIds.has(state.expectedReadEventId)
        : [...state.observedReadEventIds].some((eventId) => eventId !== state.initialReadEventId))
    if (!pointerMatches) return
    this.explicitUnread.delete(streamId)
    this.committed.delete(streamId)
  }
}

export const ReadCommitQueueContext = createContext<ReadCommitQueue | null>(null)

export function useReadCommitQueue(): ReadCommitQueue {
  const queue = useContext(ReadCommitQueueContext)
  if (!queue) throw new Error("useReadCommitQueue must be used within a ReadCommitQueueContext provider")
  return queue
}
