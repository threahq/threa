import type { SqliteMirror } from "./client"

function inactive(): DOMException {
  return new DOMException("The transaction has finished.", "TransactionInactiveError")
}

function aborted(): DOMException {
  return new DOMException("The transaction was aborted.", "AbortError")
}

/**
 * Stands in for a readonly IndexedDB transaction whose reads SQLite serves,
 * with the surface Dexie's Transaction uses. Like IndexedDB's auto-commit it
 * completes once no request is pending and a macrotask passes without a new
 * one. Reads wait for `blockers`, the readwrite transactions over the same
 * stores that were still running when it was created, as IndexedDB would;
 * from its first read until it finishes, later commits to its stores wait for
 * it, so all its reads see one state.
 */
export class EmulatedTransaction extends EventTarget {
  readonly mode = "readonly"
  error: DOMException | null = null
  oncomplete: ((event: Event) => void) | null = null
  onabort: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  private pending = 0
  private requests = 0
  private state: "active" | "complete" | "aborted" = "active"
  private snapshot: Promise<void> | null = null
  private finish: () => void = () => {}
  private readonly finished = new Promise<void>((resolve) => (this.finish = resolve))
  private rejectPending: (error: DOMException) => void = () => {}
  /** Rejects every pending request at abort, as IndexedDB fails them, without waiting for SQLite to answer. */
  private readonly abortedWhilePending = new Promise<never>((_, reject) => (this.rejectPending = reject))

  constructor(
    readonly mirror: SqliteMirror,
    readonly storeNames: readonly string[],
    private readonly blockers: readonly Promise<void>[]
  ) {
    super()
    this.abortedWhilePending.catch(() => {})
    this.scheduleCompletion()
  }

  run<T>(read: () => Promise<T>): Promise<T> {
    if (this.state !== "active") return Promise.reject(inactive())
    this.pending++
    this.requests++
    const ready = this.blockers.length > 0 ? Promise.all(this.blockers) : Promise.resolve()
    const request = ready
      .then(() => (this.snapshot ??= this.mirror.snapshot(this.storeNames, this.finished)))
      .then(() => {
        if (this.state === "aborted") throw aborted()
        return read()
      })
      .finally(() => {
        this.pending--
        this.scheduleCompletion()
      })
      .then((result) => {
        if (this.state === "aborted") throw aborted()
        return result
      })
    return Promise.race([request, this.abortedWhilePending])
  }

  /** Stays active until `done` settles, as for a pending request. */
  hold(done: Promise<unknown>): void {
    this.pending++
    void done.finally(() => {
      this.pending--
      this.scheduleCompletion()
    })
  }

  abort(): void {
    if (this.state !== "active") return
    this.state = "aborted"
    this.rejectPending(aborted())
    setTimeout(() => this.dispatch("abort"), 0)
  }

  private scheduleCompletion(): void {
    if (this.pending > 0 || this.state !== "active") return
    const seen = this.requests
    setTimeout(() => {
      if (this.state !== "active" || this.pending > 0 || this.requests !== seen) return
      this.state = "complete"
      this.dispatch("complete")
    }, 0)
  }

  private dispatch(type: "complete" | "abort"): void {
    this.finish()
    const event = new Event(type)
    this.dispatchEvent(event)
    ;(type === "complete" ? this.oncomplete : this.onabort)?.call(this, event)
  }
}
