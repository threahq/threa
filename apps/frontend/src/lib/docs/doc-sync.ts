import * as Y from "yjs"
import { base64ToBytes, bytesToBase64 } from "@threahq/crypto"
import type { DocUpdatedPayload } from "@threahq/types"
import { ApiError, isPermanentApiError } from "@/api/client"
import { docsApi } from "@/api/docs"
import { enqueueDocUpdate } from "@/sync/operation-queue"

/** Transaction origin of every update that came from the server; anything else is a local edit to send. */
export const REMOTE_ORIGIN = Symbol("doc-sync-remote")

/** Longest a run of non-boundary edits waits, counted from its first change. */
export const FLUSH_CAP_MS = 2500
const MAX_BACKOFF_MS = 10_000
const BOUNDARY_TEXT = /[\s\p{P}]$/u

export type DocSyncStatus = { phase: "loading" } | { phase: "ready" } | { phase: "error"; error: unknown }

type DocsApi = Pick<typeof docsApi, "get" | "listUpdates" | "postUpdate">

function backoffMs(failures: number): number {
  return Math.min(1000 * 2 ** (failures - 1), MAX_BACKOFF_MS)
}

/** A word, block, formatting, or delete boundary: worth saving at once rather than at the cap. */
function isBoundary(update: Uint8Array): boolean {
  const { structs, ds } = Y.decodeUpdate(update)
  if (ds.clients.size > 0) return true
  return structs.some((struct) => {
    if (!(struct instanceof Y.Item)) return false
    const { content } = struct
    if (content instanceof Y.ContentString) return BOUNDARY_TEXT.test(content.str)
    return content instanceof Y.ContentType || content instanceof Y.ContentFormat || content instanceof Y.ContentDeleted
  })
}

function sameStatus(a: DocSyncStatus, b: DocSyncStatus): boolean {
  if (a.phase !== b.phase) return false
  if (a.phase === "error" && b.phase === "error") return a.error === b.error
  return true
}

/** Keeps one `Y.Doc` in sync with a doc stream over REST, fed live `doc:updated` payloads by the caller. */
export class DocSync {
  private readonly workspaceId: string
  private readonly docId: string
  private readonly ydoc: Y.Doc
  private readonly api: DocsApi
  private readonly onRejected?: (refusal: ApiError) => void
  private readonly onLost?: (error: unknown) => void
  private readonly onSaved?: () => void
  private readonly kickOperationQueue: () => void
  private readonly listeners = new Set<() => void>()
  private status: DocSyncStatus = { phase: "loading" }
  private seq: number | null = null
  private highestSeen = 0
  // Every local update the server has not acked. A POST always carries all of them: the server refuses bytes whose dependencies it lacks.
  private unacked: Uint8Array[] = []
  private capTimer: ReturnType<typeof setTimeout> | null = null
  private flushRun: Promise<void> | null = null
  private flushAgain = false
  private catchUpTimer: ReturnType<typeof setTimeout> | null = null
  private catchUpFailures = 0
  private catchUpRun: Promise<void> | null = null
  private catchUpAgain = false
  private stopped = false

  constructor(params: {
    workspaceId: string
    docId: string
    ydoc: Y.Doc
    api?: DocsApi
    /** Called after the server permanently refused local edits; they were dropped and the doc reloaded. */
    onRejected?: (refusal: ApiError) => void
    /** Called when unsent edits could not be handed to the operation queue either; they are gone. */
    onLost?: (error: unknown) => void
    /** Called each time the server applies a flush of local edits. */
    onSaved?: () => void
    kickOperationQueue: () => void
  }) {
    this.workspaceId = params.workspaceId
    this.docId = params.docId
    this.ydoc = params.ydoc
    this.api = params.api ?? docsApi
    this.onRejected = params.onRejected
    this.onLost = params.onLost
    this.onSaved = params.onSaved
    this.kickOperationQueue = params.kickOperationQueue
  }

  getStatus = (): DocSyncStatus => this.status

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): Promise<void> {
    this.ydoc.on("update", this.onLocalUpdate)
    return this.load()
  }

  retry(): Promise<void> {
    return this.load()
  }

  /** Detaches; edits the server has not acked go to the operation queue. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.ydoc.off("update", this.onLocalUpdate)
    this.clearCapTimer()
    if (this.catchUpTimer) clearTimeout(this.catchUpTimer)
    this.listeners.clear()
    if (this.unacked.length > 0) void this.handOff()
  }

  /** Sends every unacked edit now; one request is in flight at a time, so a call during one runs after it. */
  flush(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.clearCapTimer()
    if (this.flushRun) {
      this.flushAgain = true
      return this.flushRun
    }
    if (this.unacked.length === 0) return Promise.resolve()
    this.flushRun = this.runFlush()
    return this.flushRun
  }

  /** Hands unacked edits to the operation queue without waiting: for a page that is about to unload. */
  queueUnsent(): void {
    if (!this.stopped && this.unacked.length > 0) void this.handOff()
  }

  receive = (payload: DocUpdatedPayload): void => {
    if (payload.workspaceId !== this.workspaceId || payload.streamId !== this.docId || this.stopped) return
    this.highestSeen = Math.max(this.highestSeen, payload.seq)
    if (this.seq === null || payload.seq <= this.seq) return
    if (payload.seq === this.seq + 1) {
      this.applyRemote(payload.update)
      this.seq = payload.seq
      return
    }
    void this.catchUp()
  }

  catchUp(): Promise<void> {
    if (this.seq === null || this.stopped) return Promise.resolve()
    if (this.catchUpRun) {
      this.catchUpAgain = true
      return this.catchUpRun
    }
    this.catchUpRun = this.runCatchUp()
    return this.catchUpRun
  }

  private get hasMissed(): boolean {
    return this.seq !== null && this.highestSeen > this.seq
  }

  private async load(): Promise<void> {
    this.setStatus({ phase: "loading" })
    try {
      await this.reload()
    } catch (error) {
      if (!this.stopped) this.setStatus({ phase: "error", error })
      return
    }
    if (this.stopped) return
    this.setStatus({ phase: "ready" })
    if (this.hasMissed) void this.catchUp()
  }

  private async reload(): Promise<void> {
    const stateVector = this.seq === null ? undefined : bytesToBase64(Y.encodeStateVector(this.ydoc))
    const doc = await this.api.get(this.workspaceId, this.docId, stateVector)
    if (this.stopped) return
    this.applyRemote(doc.state)
    this.seq = Math.max(this.seq ?? 0, doc.seq)
  }

  private async runCatchUp(): Promise<void> {
    if (this.catchUpTimer) clearTimeout(this.catchUpTimer)
    this.catchUpTimer = null
    try {
      do {
        this.catchUpAgain = false
        if (this.seq === null) return
        try {
          await this.fetchMissed(this.seq)
          this.catchUpFailures = 0
        } catch (error) {
          if (this.stopped) return
          if (isPermanentApiError(error)) {
            this.setStatus({ phase: "error", error })
            return
          }
          this.catchUpFailures += 1
          this.catchUpTimer = setTimeout(() => void this.catchUp(), backoffMs(this.catchUpFailures))
          return
        }
      } while (this.catchUpAgain && !this.stopped)
    } finally {
      // Cleared in the same tick as the last `catchUpAgain` check, so no request can land on a finished run.
      this.catchUpRun = null
    }
  }

  private async fetchMissed(after: number): Promise<void> {
    try {
      const { updates } = await this.api.listUpdates(this.workspaceId, this.docId, after)
      if (this.stopped) return
      let seq = this.seq ?? after
      for (const update of updates) {
        if (update.seq <= seq) continue
        this.applyRemote(update.update)
        seq = update.seq
      }
      this.seq = seq
    } catch (error) {
      if (ApiError.isApiError(error) && error.status === 409) return this.reload()
      throw error
    }
  }

  private onLocalUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === REMOTE_ORIGIN) return
    this.unacked.push(update)
    if (isBoundary(update)) {
      void this.flush()
      return
    }
    this.capTimer ??= setTimeout(() => {
      this.capTimer = null
      void this.flush()
    }, FLUSH_CAP_MS)
  }

  private clearCapTimer(): void {
    if (this.capTimer) clearTimeout(this.capTimer)
    this.capTimer = null
  }

  /**
   * Entered only with unacked edits, so every pass awaits before it can return. A hand-off or reload is a pass
   * too: an edit typed while one waits sets `flushAgain` and gets its own pass instead of waiting for the next trigger.
   */
  private async runFlush(): Promise<void> {
    try {
      do {
        this.flushAgain = false
        if (!navigator.onLine) {
          await this.handOff()
          continue
        }
        const carried = new Set(this.unacked)
        try {
          await this.post(Y.mergeUpdates([...carried]))
        } catch (error) {
          if (this.stopped) return
          if (isPermanentApiError(error)) await this.discardRefusedEdits(error)
          else await this.handOff()
          continue
        }
        this.unacked = this.unacked.filter((update) => !carried.has(update))
      } while (this.flushAgain && !this.stopped && this.unacked.length > 0)
    } finally {
      // Cleared in the same tick as the last `flushAgain` check, so no request can land on a finished run.
      this.flushRun = null
    }
  }

  /**
   * Bytes stay in `unacked` too: the next flush re-sends them and the server skips what it already holds.
   * No kick while offline: the queue would burn its retry budget on requests that cannot leave the device.
   */
  private async handOff(): Promise<void> {
    try {
      await enqueueDocUpdate(this.workspaceId, this.docId, bytesToBase64(Y.mergeUpdates(this.unacked)))
    } catch (error) {
      console.error("Doc edits could not be queued for retry", { docId: this.docId, error })
      // A live sync still holds the bytes and re-sends them; only a stopped one has nowhere left to keep them.
      if (this.stopped) this.onLost?.(error)
      return
    }
    if (navigator.onLine) this.kickOperationQueue()
  }

  private async post(update: Uint8Array): Promise<void> {
    const before = this.seq
    const result = await this.api.postUpdate(this.workspaceId, this.docId, bytesToBase64(update))
    // Advance only past our own row, and only when the head did not move during the request: a no-op answers a head
    // that may be a peer's row, a server stamp adds a row after ours, and any head that moved meanwhile belongs to
    // the broadcasts, which apply each row in order.
    if (result.applied && before !== null && this.seq === before && result.seq === before + 1) this.seq = result.seq
    if (result.applied) this.onSaved?.()
  }

  private async discardRefusedEdits(error: ApiError): Promise<void> {
    this.unacked = []
    try {
      await this.reload()
    } catch {
      void this.catchUp()
    }
    if (!this.stopped) this.onRejected?.(error)
  }

  private applyRemote(update: string): void {
    Y.applyUpdate(this.ydoc, base64ToBytes(update), REMOTE_ORIGIN)
  }

  private setStatus(status: DocSyncStatus): void {
    if (sameStatus(status, this.status)) return
    this.status = status
    for (const listener of this.listeners) listener()
  }
}
