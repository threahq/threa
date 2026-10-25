import * as Y from "yjs"
import { base64ToBytes, bytesToBase64 } from "@threahq/crypto"
import type { DocUpdatedPayload } from "@threahq/types"
import { ApiError, isPermanentApiError } from "@/api/client"
import { docsApi } from "@/api/docs"

/** Transaction origin of every update that came from the server; anything else is a local edit to send. */
export const REMOTE_ORIGIN = Symbol("doc-sync-remote")

export const FLUSH_DEBOUNCE_MS = 400
const MAX_BACKOFF_MS = 10_000

export type DocSyncStatus = { phase: "loading" } | { phase: "ready" } | { phase: "error"; error: unknown }

type DocsApi = typeof docsApi

function backoffMs(failures: number): number {
  return Math.min(1000 * 2 ** (failures - 1), MAX_BACKOFF_MS)
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
  private readonly listeners = new Set<() => void>()
  private status: DocSyncStatus = { phase: "loading" }
  private seq: number | null = null
  private highestSeen = 0
  private pending: Uint8Array[] = []
  private inFlight: { update: Uint8Array; request: Promise<void> } | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushFailures = 0
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
  }) {
    this.workspaceId = params.workspaceId
    this.docId = params.docId
    this.ydoc = params.ydoc
    this.api = params.api ?? docsApi
    this.onRejected = params.onRejected
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

  /** Detaches; edits not yet saved (debounced, in flight, or awaiting a retry) are sent once more, unobserved. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.ydoc.off("update", this.onLocalUpdate)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.catchUpTimer) clearTimeout(this.catchUpTimer)
    this.listeners.clear()
    this.flushOnStop()
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
    const doc = await this.api.get(this.workspaceId, this.docId)
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
    this.pending.push(update)
    this.scheduleFlush(FLUSH_DEBOUNCE_MS)
  }

  private scheduleFlush(delayMs: number): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, delayMs)
  }

  private async flush(): Promise<void> {
    if (this.inFlight || this.pending.length === 0 || this.stopped) return
    const update = Y.mergeUpdates(this.pending)
    this.pending = []
    this.inFlight = { update, request: this.post(update) }
    try {
      await this.inFlight.request
      this.flushFailures = 0
    } catch (error) {
      if (this.stopped) return
      if (isPermanentApiError(error)) {
        await this.discardRefusedEdits(error)
      } else {
        this.pending.unshift(update)
        this.flushFailures += 1
        this.scheduleFlush(backoffMs(this.flushFailures))
      }
    } finally {
      this.inFlight = null
    }
    if (this.pending.length > 0 && !this.flushTimer && !this.stopped) this.scheduleFlush(FLUSH_DEBOUNCE_MS)
  }

  private flushOnStop(): void {
    const inFlight = this.inFlight
    const pending = this.pending
    this.pending = []
    if (!inFlight && pending.length === 0) return
    // Queued behind a POST still in flight: these bytes can depend on it, so a transient failure resends it too.
    const toSend = inFlight
      ? inFlight.request.then(
          () => pending,
          (error: unknown) => (isPermanentApiError(error) ? pending : [inFlight.update, ...pending])
        )
      : Promise.resolve(pending)
    void toSend
      .then((updates) => {
        if (updates.length === 0) return
        return this.api.postUpdate(this.workspaceId, this.docId, bytesToBase64(Y.mergeUpdates(updates)))
      })
      .catch((error: unknown) =>
        console.error("Doc edits made before closing were not saved", { docId: this.docId, error })
      )
  }

  private async post(update: Uint8Array): Promise<void> {
    const result = await this.api.postUpdate(this.workspaceId, this.docId, bytesToBase64(update))
    // Only a single new row is provably ours; a server repair adds a second one this client must still apply.
    if (this.seq !== null && result.seq === this.seq + 1) this.seq = result.seq
  }

  private async discardRefusedEdits(error: ApiError): Promise<void> {
    this.pending = []
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
