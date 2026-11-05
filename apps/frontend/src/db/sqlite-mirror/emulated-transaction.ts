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
 * one. The worker admits every one in creation order, as IndexedDB orders
 * overlapping ones, so a readonly one sees no write made after it was created.
 * A readwrite one completes once SQLite acknowledges the commit; an abort
 * rolls back first.
 */
export class EmulatedTransaction extends EventTarget {
  error: DOMException | null = null
  oncomplete: ((event: Event) => void) | null = null
  onabort: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  /** The worker transaction ordering it among the others. */
  readonly id: number
  private pending = 0
  private requests = 0
  private commitRequested = false
  private state: "active" | "finishing" | "complete" | "aborted" = "active"
  private rejectPending: (error: DOMException) => void = () => {}
  /** Rejects every pending request at abort, as IndexedDB fails them, without waiting for SQLite to answer. */
  private readonly abortedWhilePending = new Promise<never>((_, reject) => (this.rejectPending = reject))

  constructor(
    readonly mirror: SqliteMirror,
    readonly storeNames: readonly string[],
    readonly mode: "readonly" | "readwrite"
  ) {
    super()
    this.abortedWhilePending.catch(() => {})
    this.id = mirror.beginTransaction(mode)
    this.scheduleCompletion()
  }

  run<T>(read: () => Promise<T>): Promise<T> {
    if (this.state !== "active" || this.commitRequested) return Promise.reject(inactive())
    this.pending++
    this.requests++
    const request = Promise.resolve()
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
    void this.mirror.rollbackTransaction(this.id).then(() => nextTask(() => this.dispatch("abort")))
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
    this.state = "finishing"
    this.mirror.commitTransaction(this.id).then(
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
    const event = new Event(type)
    this.dispatchEvent(event)
    ;(type === "complete" ? this.oncomplete : this.onabort)?.call(this, event)
  }
}
