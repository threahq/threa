import type { SqliteMirror } from "./client"

function inactive(): DOMException {
  return new DOMException("The transaction has finished.", "TransactionInactiveError")
}

function aborted(): DOMException {
  return new DOMException("The transaction was aborted.", "AbortError")
}

/** A macrotask that hidden tabs do not throttle, as they do timers. */
function nextTask(callback: () => void): void {
  const { port1, port2 } = new MessageChannel()
  port1.onmessage = () => {
    port1.close()
    callback()
  }
  port2.postMessage(null)
}

/**
 * Stands in for an IndexedDB transaction whose requests SQLite serves, with
 * the surface Dexie's Transaction uses. Like IndexedDB's auto-commit it
 * completes once no request is pending and a macrotask passes without a new
 * one.
 *
 * Under read-only storage only readonly ones exist. Their reads wait for
 * `blockers`, the native readwrite transactions over the same stores still
 * running when it was created; from its first read until it finishes, later
 * commits to its stores wait for it, so all its reads see one state.
 *
 * Under read-write storage the worker admits every one in creation order, as
 * IndexedDB orders overlapping ones, so a readonly one sees no write made
 * after it was created. A readwrite one completes once SQLite acknowledges the
 * commit; an abort rolls back first.
 */
export class EmulatedTransaction extends EventTarget {
  error: DOMException | null = null
  oncomplete: ((event: Event) => void) | null = null
  onabort: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  /** The worker transaction ordering it among the others, under read-write storage. */
  readonly id: number | undefined
  private pending = 0
  private requests = 0
  private commitRequested = false
  private state: "active" | "finishing" | "complete" | "aborted" = "active"
  private snapshot: Promise<void> | null = null
  private settle: () => void = () => {}
  private readonly settled = new Promise<void>((resolve) => (this.settle = resolve))
  private rejectPending: (error: DOMException) => void = () => {}
  /** Rejects every pending request at abort, as IndexedDB fails them, without waiting for SQLite to answer. */
  private readonly abortedWhilePending = new Promise<never>((_, reject) => (this.rejectPending = reject))

  constructor(
    readonly mirror: SqliteMirror,
    readonly storeNames: readonly string[],
    readonly mode: "readonly" | "readwrite",
    private readonly blockers: readonly Promise<void>[] = []
  ) {
    super()
    this.abortedWhilePending.catch(() => {})
    this.id = mirror.readWrite ? mirror.beginTransaction(mode) : undefined
    this.scheduleCompletion()
  }

  run<T>(read: () => Promise<T>): Promise<T> {
    if (this.state !== "active" || this.commitRequested) return Promise.reject(inactive())
    this.pending++
    this.requests++
    const ready = this.blockers.length > 0 ? Promise.all(this.blockers) : Promise.resolve()
    const request = ready
      .then(() => {
        if (this.id === undefined) return (this.snapshot ??= this.mirror.snapshot(this.storeNames, this.settled))
      })
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

  /** Like IndexedDB's: no new requests, and the commit follows the pending ones without waiting a macrotask. */
  commit(): void {
    if (this.state !== "active") throw inactive()
    this.commitRequested = true
    if (this.pending === 0) this.finish()
  }

  abort(): void {
    if (this.state !== "active") return
    this.state = "aborted"
    this.rejectPending(aborted())
    const rolledBack = this.id === undefined ? Promise.resolve() : this.mirror.rollbackTransaction(this.id)
    void rolledBack.then(() => nextTask(() => this.dispatch("abort")))
  }

  private scheduleCompletion(): void {
    if (this.pending > 0 || this.state !== "active") return
    if (this.commitRequested) return this.finish()
    const seen = this.requests
    nextTask(() => {
      if (this.state !== "active" || this.pending > 0 || this.requests !== seen) return
      this.finish()
    })
  }

  private finish(): void {
    if (this.id === undefined) {
      this.state = "complete"
      this.dispatch("complete")
      return
    }
    this.state = "finishing"
    this.mirror.commitTransaction(this.id, this.mode === "readwrite").then(
      () => {
        this.state = "complete"
        this.dispatch("complete")
      },
      (error: unknown) => {
        this.state = "aborted"
        this.error = error instanceof DOMException ? error : new DOMException(String(error), "UnknownError")
        this.dispatch("abort")
      }
    )
  }

  private dispatch(type: "complete" | "abort"): void {
    this.settle()
    const event = new Event(type)
    this.dispatchEvent(event)
    ;(type === "complete" ? this.oncomplete : this.onabort)?.call(this, event)
  }
}
