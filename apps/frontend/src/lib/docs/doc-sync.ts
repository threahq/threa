import * as Y from "yjs"
import { base64ToBytes, bytesToBase64 } from "@threahq/crypto"
import type { DocUpdatedOutboxPayload } from "@threahq/types"
import { ApiError, isPermanentApiError } from "@/api/client"
import { docsApi } from "@/api/docs"

/** Transaction origin of every update that came from the server; anything else is a local edit to send. */
export const REMOTE_ORIGIN = Symbol("doc-sync-remote")

const FLUSH_DEBOUNCE_MS = 400
const MAX_BACKOFF_MS = 10_000

type DocSyncPhase =
  | { phase: "loading" }
  | { phase: "ready" }
  | { phase: "error"; error: unknown }
  | { phase: "rejected"; code: string }

export type DocSyncStatus = DocSyncPhase & { saving: boolean }

type DocsApi = Pick<typeof docsApi, "get" | "listUpdates" | "postUpdate">

function backoffMs(failures: number): number {
  return Math.min(1000 * 2 ** (failures - 1), MAX_BACKOFF_MS)
}

function sameStatus(a: DocSyncStatus, b: DocSyncStatus): boolean {
  if (a.phase !== b.phase || a.saving !== b.saving) return false
  if (a.phase === "error" && b.phase === "error") return a.error === b.error
  if (a.phase === "rejected" && b.phase === "rejected") return a.code === b.code
  return true
}

/** Keeps one `Y.Doc` in sync with a doc stream over REST, fed live `doc:updated` payloads by the caller. */
export class DocSync {
  private readonly workspaceId: string
  private readonly docId: string
  private readonly ydoc: Y.Doc
  private readonly api: DocsApi
  private readonly listeners = new Set<() => void>()
  private status: DocSyncStatus = { phase: "loading", saving: false }
  private seq: number | null = null
  private highestSeen = 0
  private pending: Uint8Array[] = []
  private posting = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushFailures = 0
  private catchUpTimer: ReturnType<typeof setTimeout> | null = null
  private catchUpFailures = 0
  private catchUpRun: Promise<void> | null = null
  private catchUpAgain = false
  private stopped = false

  constructor(params: { workspaceId: string; docId: string; ydoc: Y.Doc; api?: DocsApi }) {
    this.workspaceId = params.workspaceId
    this.docId = params.docId
    this.ydoc = params.ydoc
    this.api = params.api ?? docsApi
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

  stop(): void {
    this.stopped = true
    this.ydoc.off("update", this.onLocalUpdate)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.catchUpTimer) clearTimeout(this.catchUpTimer)
    this.listeners.clear()
  }

  receive(payload: DocUpdatedOutboxPayload): void {
    if (payload.streamId !== this.docId || this.stopped) return
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

  private async load(): Promise<void> {
    this.setPhase({ phase: "loading" })
    try {
      await this.reload()
    } catch (error) {
      if (!this.stopped) this.setPhase({ phase: "error", error })
      return
    }
    if (this.stopped) return
    this.setPhase({ phase: "ready" })
    if (this.highestSeen > this.seq!) void this.catchUp()
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
    // Cleared in the same tick as the last `catchUpAgain` check, so no request can land on a finished run.
    try {
      do {
        this.catchUpAgain = false
        try {
          await this.fetchMissed()
          this.catchUpFailures = 0
        } catch {
          if (this.stopped) return
          this.catchUpFailures += 1
          this.catchUpTimer = setTimeout(() => void this.catchUp(), backoffMs(this.catchUpFailures))
          return
        }
      } while (this.catchUpAgain && !this.stopped)
    } finally {
      this.catchUpRun = null
    }
  }

  private async fetchMissed(): Promise<void> {
    try {
      const { updates } = await this.api.listUpdates(this.workspaceId, this.docId, this.seq!)
      if (this.stopped) return
      for (const update of updates) {
        if (update.seq <= this.seq!) continue
        this.applyRemote(update.update)
        this.seq = update.seq
      }
    } catch (error) {
      if (ApiError.isApiError(error) && error.status === 409) return this.reload()
      throw error
    }
  }

  private onLocalUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === REMOTE_ORIGIN) return
    this.pending.push(update)
    this.updateSaving()
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
    if (this.posting || this.pending.length === 0 || this.stopped) return
    const update = Y.mergeUpdates(this.pending)
    this.pending = []
    this.posting = true
    try {
      await this.post(update)
      this.flushFailures = 0
      if (this.status.phase === "rejected") this.setPhase({ phase: "ready" })
    } catch (error) {
      if (this.stopped) return
      if (isPermanentApiError(error)) {
        await this.reject(error)
      } else {
        this.pending.unshift(update)
        this.flushFailures += 1
        this.scheduleFlush(backoffMs(this.flushFailures))
      }
    } finally {
      this.posting = false
      this.updateSaving()
    }
    if (this.pending.length > 0 && !this.flushTimer && !this.stopped) this.scheduleFlush(FLUSH_DEBOUNCE_MS)
  }

  private async post(update: Uint8Array): Promise<void> {
    const encoded = bytesToBase64(update)
    let result
    try {
      result = await this.api.postUpdate(this.workspaceId, this.docId, encoded)
    } catch (error) {
      if (!ApiError.isApiError(error) || error.code !== "DOC_UPDATE_NOT_APPLICABLE") throw error
      await this.catchUp()
      if (this.stopped) return
      result = await this.api.postUpdate(this.workspaceId, this.docId, encoded)
    }
    // Only a single new row is provably ours; a server repair adds a second one this client must still apply.
    if (this.seq !== null && result.seq === this.seq + 1) this.seq = result.seq
  }

  private async reject(error: ApiError): Promise<void> {
    this.pending = []
    try {
      await this.reload()
    } catch {
      void this.catchUp()
    }
    if (!this.stopped) this.setPhase({ phase: "rejected", code: error.code })
  }

  private applyRemote(update: string): void {
    Y.applyUpdate(this.ydoc, base64ToBytes(update), REMOTE_ORIGIN)
  }

  private updateSaving(): void {
    const saving = this.posting || this.pending.length > 0
    if (saving !== this.status.saving) this.setStatus({ ...this.status, saving })
  }

  private setPhase(phase: DocSyncPhase): void {
    this.setStatus({ ...phase, saving: this.status.saving })
  }

  private setStatus(status: DocSyncStatus): void {
    if (sameStatus(status, this.status)) return
    this.status = status
    for (const listener of this.listeners) listener()
  }
}
