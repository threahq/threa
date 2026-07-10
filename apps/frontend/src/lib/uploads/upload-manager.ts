/**
 * App-level background upload manager.
 *
 * Uploads are workspace-scoped jobs owned by this module, NOT by any composer:
 * a job's lifetime is independent of component mount, composer clear, and
 * navigation. The flow per job:
 *
 *   1. reserve — POST /attachments/reservations returns a real `attach_…` id
 *      before any byte moves, so a message can bind the id immediately
 *      (send-while-uploading).
 *   2. persist — the file bytes + metadata land in IDB (`uploadJobs`), so a
 *      reload or PWA reopen resumes the transfer (`resumeWorkspaceUploads`).
 *   3. upload — XHR streams the bytes with real progress, retrying transient
 *      failures with backoff and pausing while offline.
 *   4. settle — success deletes the IDB row; terminal failure marks the job
 *      failed locally AND reports it to the server so every viewer of a
 *      message that bound the id sees "Upload failed" instead of a forever
 *      spinner.
 *
 * Composers hold job references (`useAttachments`); releasing them never
 * aborts the transfer — only an explicit cancel does.
 *
 * E2E: bytes are encrypted before anything leaves the page; IDB holds only
 * ciphertext, and the key/iv ride the existing memory-only ref bridge
 * (`rememberAttachmentRef`) exactly as before.
 */

import { attachmentsApi } from "@/api"
import { API_BASE } from "@/api/client"
import { db, type CachedUploadJob } from "@/db"
import { encryptAttachmentBytes, rememberAttachmentRef } from "@/lib/crypto/attachment-crypto"
import { uploadGalleryType } from "@/components/gallery/upload-preview"
// Namespace import so tests can spy the transport seam (INV-48).
import * as xhrTransport from "./xhr-upload"
import { XhrNetworkError } from "./xhr-upload"

/** The placeholder name/mime the server forces for E2E ciphertext uploads. */
const E2E_CIPHERTEXT_FILENAME = "encrypted"
const E2E_CIPHERTEXT_MIME = "application/octet-stream"

/** Backoff for transient (network / 5xx / 429) failures before going terminal. */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000]

export type UploadJobStatus = "reserving" | "uploading" | "uploaded" | "error"

export interface UploadJob {
  /**
   * Stable job key, `temp_…`-shaped so it can double as the chip id until the
   * reservation lands (send paths already exclude `temp_` ids).
   */
  jobId: string
  workspaceId: string
  /** Real `attach_…` id once the reservation lands. */
  attachmentId: string | null
  filename: string
  mimeType: string
  sizeBytes: number
  e2e: boolean
  status: UploadJobStatus
  /** Bytes-on-the-wire fraction, 0..1. */
  progress: number
  error?: string
  /** Local object URL for previewable files; revoked when the job is freed. */
  previewUrl?: string
  /**
   * No composer holds this job anymore (sent, or the draft was cleared).
   * Released jobs free their resources when they settle successfully; failed
   * ones stay so the timeline chip can offer a retry with the local bytes.
   */
  released: boolean
  /**
   * The failure was network-class (connection drop / 5xx / 429 exhausted) —
   * the bytes are fine and a retry can succeed. Drives the auto-heal on the
   * `online` event; 4xx rejections and blocked verdicts stay terminal.
   */
  retryable?: boolean
}

interface ManagerState {
  jobs: Map<string, UploadJob>
  version: number
}

const state: ManagerState = { jobs: new Map(), version: 0 }
const listeners = new Set<() => void>()
/** attachmentId → jobId, for chip/timeline lookups after the id flip. */
const jobIdByAttachmentId = new Map<string, string>()
const controllers = new Map<string, AbortController>()
/** The upload payload (original file, or ciphertext for E2E) kept for retries. */
const blobs = new Map<string, Blob>()

let jobCounter = 0
function newJobId(): string {
  return `temp_${Date.now()}_${(++jobCounter).toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function emit(): void {
  state.version++
  for (const listener of listeners) listener()
}

export function subscribeUploads(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getUploadsVersion(): number {
  return state.version
}

export function getUploadJob(jobId: string): UploadJob | undefined {
  return state.jobs.get(jobId)
}

export function getUploadJobByAttachmentId(attachmentId: string): UploadJob | undefined {
  const jobId = jobIdByAttachmentId.get(attachmentId)
  return jobId ? state.jobs.get(jobId) : undefined
}

/** Resolve either key kind (jobId or attachmentId) to the job. */
export function findUploadJob(id: string): UploadJob | undefined {
  return state.jobs.get(id) ?? getUploadJobByAttachmentId(id)
}

function patchJob(jobId: string, patch: Partial<UploadJob>): UploadJob | undefined {
  const job = state.jobs.get(jobId)
  if (!job) return undefined
  const next = { ...job, ...patch }
  state.jobs.set(jobId, next)
  emit()
  return next
}

function createPreviewUrl(blob: Blob, facts: { filename: string; mimeType: string }): string | undefined {
  if (!uploadGalleryType({ mimeType: facts.mimeType, filename: facts.filename })) return undefined
  try {
    return URL.createObjectURL(blob)
  } catch {
    return undefined
  }
}

function revokePreviewUrl(url: string | undefined): void {
  if (!url) return
  try {
    URL.revokeObjectURL(url)
  } catch {
    // no-op — jsdom
  }
}

/** Drop a job and everything it pins (preview URL, blob, abort controller). */
function freeJob(jobId: string): void {
  const job = state.jobs.get(jobId)
  if (!job) return
  revokePreviewUrl(job.previewUrl)
  blobs.delete(jobId)
  controllers.get(jobId)?.abort()
  controllers.delete(jobId)
  if (job.attachmentId) jobIdByAttachmentId.delete(job.attachmentId)
  state.jobs.delete(jobId)
  emit()
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

/** Resolve when the browser reports connectivity (immediately when online). */
function waitForOnline(signal: AbortSignal): Promise<void> {
  if (typeof navigator === "undefined" || navigator.onLine !== false) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onOnline = () => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }
    const onAbort = () => {
      window.removeEventListener("online", onOnline)
      reject(new DOMException("Aborted", "AbortError"))
    }
    window.addEventListener("online", onOnline, { once: true })
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError"
}

/**
 * Auto-heal: when connectivity returns, network-failed jobs retry themselves
 * — a tunnel or dead radio shouldn't require a manual tap once the device is
 * back online. Registered lazily on first use; 4xx/blocked failures are not
 * retryable and stay terminal.
 */
let onlineListenerRegistered = false
function ensureOnlineAutoRetry(): void {
  if (onlineListenerRegistered || typeof window === "undefined") return
  onlineListenerRegistered = true
  window.addEventListener("online", () => {
    for (const job of state.jobs.values()) {
      if (job.status === "error" && job.retryable && job.attachmentId) {
        void retryUpload(job.attachmentId)
      }
    }
  })
}

/**
 * Serialize the transfer per attachment id across tabs: `uploadJobs` is a
 * shared per-origin IDB table, so two tabs resuming the same persisted job
 * would otherwise stream the same bytes concurrently (the server tolerates
 * it, but the loser's chip would misreport). The Web Lock queues the second
 * tab; when it acquires, the settled-probe below turns its run into a no-op.
 */
function withUploadLock<T>(attachmentId: string, fn: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) return fn()
  return navigator.locks.request(`threa-upload-${attachmentId}`, fn) as Promise<T>
}

/**
 * Did the upload already settle server-side (another tab/device won a
 * duplicate completion)? A shareable attachment resolves a download URL;
 * a pending/failed one is 403/404.
 */
async function probeSettled(workspaceId: string, attachmentId: string): Promise<boolean> {
  try {
    await attachmentsApi.getDownloadUrl(workspaceId, attachmentId)
    return true
  } catch {
    return false
  }
}

/** Blob → bytes, with a FileReader fallback for jsdom (no Blob.arrayBuffer). */
async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer())
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"))
    reader.readAsArrayBuffer(blob)
  })
}

export interface StartUploadOptions {
  e2e?: boolean
}

/**
 * Start a new upload job for a picked/pasted file. Returns the job in its
 * initial `reserving` state synchronously; the id becomes real once the
 * reservation lands (await {@link waitForReservation}).
 */
export function startUpload(workspaceId: string, file: File, options?: StartUploadOptions): UploadJob {
  ensureOnlineAutoRetry()
  const jobId = newJobId()
  const controller = new AbortController()
  controllers.set(jobId, controller)

  const job: UploadJob = {
    jobId,
    workspaceId,
    attachmentId: null,
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    e2e: options?.e2e === true,
    status: "reserving",
    progress: 0,
    previewUrl: createPreviewUrl(file, { filename: file.name, mimeType: file.type }),
    released: false,
  }
  state.jobs.set(jobId, job)
  emit()

  void runReserveAndUpload(jobId, file, controller.signal)
  return job
}

/** Resolves when the job leaves `reserving` (id available, or reserve failed). */
export function waitForReservation(jobId: string): Promise<UploadJob> {
  const settled = (job: UploadJob | undefined) => job && job.status !== "reserving"
  const current = state.jobs.get(jobId)
  if (!current) return Promise.reject(new Error(`Unknown upload job ${jobId}`))
  if (settled(current)) return Promise.resolve(current)
  return new Promise((resolve) => {
    const unsubscribe = subscribeUploads(() => {
      const job = state.jobs.get(jobId)
      // A cancelled job disappears from the map — surface it as an error
      // result rather than hanging the caller forever.
      if (!job) {
        unsubscribe()
        resolve({ ...current, status: "error", error: "Cancelled" })
        return
      }
      if (settled(job)) {
        unsubscribe()
        resolve(job)
      }
    })
  })
}

async function runReserveAndUpload(jobId: string, file: File, signal: AbortSignal): Promise<void> {
  try {
    const job = state.jobs.get(jobId)
    if (!job) return

    // E2E: encrypt before ANY byte leaves the page. The reservation declares
    // the ciphertext size (that's what will stream), and IDB persists only
    // ciphertext. Real facts stay on the job for the composer chip.
    let uploadBlob: Blob = file
    let e2eKeyMaterial: { key: string; iv: string } | null = null
    if (job.e2e) {
      const plaintext = await blobBytes(file)
      const { ciphertext, key, iv } = await encryptAttachmentBytes(plaintext)
      uploadBlob = new Blob([ciphertext as BlobPart], { type: E2E_CIPHERTEXT_MIME })
      e2eKeyMaterial = { key, iv }
    }
    if (signal.aborted) return

    const reservation = await attachmentsApi.reserve(
      job.workspaceId,
      {
        filename: job.e2e ? E2E_CIPHERTEXT_FILENAME : job.filename,
        mimeType: job.e2e ? E2E_CIPHERTEXT_MIME : job.mimeType,
        sizeBytes: uploadBlob.size,
        ...(job.e2e && { e2e: true }),
      },
      { signal }
    )
    const attachmentId = reservation.attachment?.id
    if (!attachmentId) throw new Error("Invalid response: missing attachment data")

    if (e2eKeyMaterial) {
      rememberAttachmentRef({
        attachmentId,
        key: e2eKeyMaterial.key,
        iv: e2eKeyMaterial.iv,
        filename: job.filename,
        mimeType: job.mimeType,
        sizeBytes: file.size,
      })
    }

    jobIdByAttachmentId.set(attachmentId, jobId)
    blobs.set(jobId, uploadBlob)
    // Durable from this point: a reload resumes the transfer from IDB. A
    // persist failure orphans nothing — the reservation is released so the
    // server isn't left holding a row no client can ever complete.
    try {
      await db.uploadJobs.put({
        attachmentId,
        workspaceId: job.workspaceId,
        filename: job.filename,
        mimeType: job.mimeType,
        sizeBytes: job.sizeBytes,
        e2e: job.e2e,
        blob: uploadBlob,
        status: "pending",
        createdAt: Date.now(),
      })
    } catch (err) {
      jobIdByAttachmentId.delete(attachmentId)
      blobs.delete(jobId)
      attachmentsApi.delete(job.workspaceId, attachmentId).catch(() => {})
      throw err
    }

    // Cancelled while the reservation/persist was in flight: removeUpload
    // couldn't clean up the durable bits (the job carried no attachmentId
    // yet), so undo them here — otherwise the orphaned IDB row would silently
    // resurrect a cancelled upload on the next resume.
    if (signal.aborted || !state.jobs.has(jobId)) {
      jobIdByAttachmentId.delete(attachmentId)
      blobs.delete(jobId)
      void db.uploadJobs.delete(attachmentId).catch(() => {})
      attachmentsApi.delete(job.workspaceId, attachmentId).catch(() => {})
      return
    }
    patchJob(jobId, { attachmentId, status: "uploading" })

    await uploadBytes(jobId, signal)
  } catch (err) {
    if (isAbortError(err) || signal.aborted) return
    patchJob(jobId, { status: "error", error: err instanceof Error ? err.message : "Upload failed" })
  }
}

/**
 * Stream the job's bytes to its reserved content endpoint, retrying transient
 * failures with backoff and holding while offline. Terminal failure marks the
 * job failed in memory + IDB and best-effort reports it to the server.
 */
async function uploadBytes(jobId: string, signal: AbortSignal): Promise<void> {
  const job = state.jobs.get(jobId)
  if (!job?.attachmentId) return
  const { workspaceId, attachmentId } = job
  await withUploadLock(attachmentId, () => uploadBytesLocked(jobId, workspaceId, attachmentId, signal))
}

/** Settle the job locally as successfully uploaded. */
async function settleJobUploaded(jobId: string, attachmentId: string): Promise<void> {
  await db.uploadJobs.delete(attachmentId).catch(() => {})
  blobs.delete(jobId)
  controllers.delete(jobId)
  const settled = patchJob(jobId, { status: "uploaded", progress: 1 })
  // Nothing references a settled, released job — the timeline renders
  // from server state (socket patch / bootstrap overlay) from here on.
  if (settled?.released) freeJob(jobId)
}

async function uploadBytesLocked(
  jobId: string,
  workspaceId: string,
  attachmentId: string,
  signal: AbortSignal
): Promise<void> {
  const job = state.jobs.get(jobId)
  const blob = blobs.get(jobId)
  if (!job || !blob || signal.aborted) return

  let terminalError = "Upload failed"
  // Network-class failures (connection drops, 5xx, 429 exhaustion) leave the
  // bytes retryable; a 4xx rejection or non-network throw is terminal.
  let terminalRetryable = true
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      await waitForOnline(signal)
      const response = await xhrTransport.xhrUpload({
        url: `${API_BASE}/api/workspaces/${workspaceId}/attachments/${attachmentId}/content`,
        blob,
        filename: job.e2e ? E2E_CIPHERTEXT_FILENAME : job.filename,
        ...(job.e2e && { fields: { e2e: "true" } }),
        signal,
        onProgress: (fraction) => {
          const current = state.jobs.get(jobId)
          if (current && (fraction - current.progress >= 0.01 || fraction === 1)) {
            patchJob(jobId, { progress: fraction })
          }
        },
      })

      if (response.status === 201) {
        await settleJobUploaded(jobId, attachmentId)
        return
      }

      const body = response.body as { error?: string; code?: string } | null
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        terminalRetryable = false
        // A duplicate completion race (another tab/device already settled this
        // upload) surfaces as 404/409 here — that's a success, not a failure.
        if ((response.status === 404 || response.status === 409) && (await probeSettled(workspaceId, attachmentId))) {
          await settleJobUploaded(jobId, attachmentId)
          return
        }
        // Quarantined by the malware scan: the verdict is server-side and
        // final — retrying the same bytes would just be quarantined again.
        // Drop the local job entirely so the chip falls through to the
        // summary state ("Blocked by malware scan"), identical to what every
        // other viewer sees, instead of a retryable-looking "Upload failed".
        if (body?.code === "attachment_blocked") {
          await db.uploadJobs.delete(attachmentId).catch(() => {})
          freeJob(jobId)
          return
        }
        terminalError = body?.error ?? `Upload rejected (${response.status})`
        break
      }
      terminalError = body?.error ?? `Upload failed (${response.status})`
    } catch (err) {
      if (isAbortError(err) || signal.aborted) return
      if (!(err instanceof XhrNetworkError)) {
        terminalError = err instanceof Error ? err.message : "Upload failed"
        terminalRetryable = false
        break
      }
      terminalError = "Network error during upload"
    }

    if (attempt < RETRY_DELAYS_MS.length) {
      try {
        await sleep(RETRY_DELAYS_MS[attempt], signal)
      } catch {
        return // aborted while waiting
      }
    }
  }

  patchJob(jobId, { status: "error", error: terminalError, retryable: terminalRetryable })
  try {
    await db.uploadJobs.update(attachmentId, { status: "failed", error: terminalError, retryable: terminalRetryable })
  } catch {
    // IDB failure only costs resume-after-reload; the in-memory job is authoritative.
  }
  // Tell the server so viewers of an already-sent message see the failure
  // instead of an eternal "Uploading…" chip. Best-effort — the staleness
  // sweep is the backstop.
  attachmentsApi.reportUploadFailure(workspaceId, attachmentId, terminalError).catch(() => {})
}

/**
 * Retry a failed job from its locally-held bytes (memory, falling back to the
 * IDB copy). No-op unless the job is in `error`.
 */
export async function retryUpload(id: string): Promise<void> {
  const job = findUploadJob(id)
  // A job whose RESERVATION failed has nothing durable to retry against —
  // the chip's only affordance is remove-and-repick, same as before.
  if (!job?.attachmentId || job.status !== "error") return

  if (!blobs.has(job.jobId)) {
    const row = await db.uploadJobs.get(job.attachmentId)
    if (!row) return
    blobs.set(job.jobId, row.blob)
  }
  const controller = new AbortController()
  controllers.set(job.jobId, controller)
  patchJob(job.jobId, { status: "uploading", progress: 0, error: undefined })
  await db.uploadJobs.update(job.attachmentId, { status: "pending", error: undefined }).catch(() => {})
  void uploadBytes(job.jobId, controller.signal)
}

/**
 * Cancel/remove an upload: abort any in-flight transfer, best-effort delete
 * the server-side reservation (also removes its tracking row), and free the
 * job. Used by the composer chip's × in every phase.
 */
export function removeUpload(id: string): void {
  const job = findUploadJob(id)
  if (!job) return
  const { attachmentId, workspaceId } = job
  freeJob(job.jobId)
  if (attachmentId) {
    void db.uploadJobs.delete(attachmentId).catch(() => {})
    attachmentsApi.delete(workspaceId, attachmentId).catch(() => {
      // Bound or already-deleted rows can't be deleted — the sweep reaps strays.
    })
  }
}

/**
 * A composer no longer holds these jobs (message sent, or draft discarded
 * without its attachments — sent is the overwhelmingly common case, and a
 * discarded draft's attachments are removed explicitly, not released).
 * Transfers keep running; settled jobs free their resources now, in-flight
 * ones when they settle, failed ones stay for the timeline retry affordance.
 */
export function releaseUploads(ids: string[]): void {
  for (const id of ids) {
    const job = findUploadJob(id)
    if (!job) continue
    if (job.status === "uploaded") {
      freeJob(job.jobId)
    } else {
      patchJob(job.jobId, { released: true })
    }
  }
}

/** Re-claim a released job (a draft restore re-attached it to a composer). */
export function claimUpload(id: string): UploadJob | undefined {
  const job = findUploadJob(id)
  if (!job) return undefined
  return job.released ? patchJob(job.jobId, { released: false }) : job
}

const resumedWorkspaces = new Set<string>()
/** Bumped by resetUploadManager so an in-flight resume can't seed stale jobs. */
let resumeEpoch = 0

/**
 * Resume this workspace's persisted upload jobs after a reload/app reopen:
 * pending rows restart their transfer immediately, failed rows surface as
 * failed (the timeline chip offers retry). Idempotent per workspace per
 * session; jobs already live in memory are skipped.
 */
export async function resumeWorkspaceUploads(workspaceId: string): Promise<void> {
  ensureOnlineAutoRetry()
  if (resumedWorkspaces.has(workspaceId)) return
  resumedWorkspaces.add(workspaceId)
  const epoch = resumeEpoch

  let rows: CachedUploadJob[]
  try {
    rows = await db.uploadJobs.where("workspaceId").equals(workspaceId).toArray()
  } catch {
    // Transient IDB failure must not permanently mark the workspace resumed —
    // the next workspace connect gets another shot.
    resumedWorkspaces.delete(workspaceId)
    return
  }
  // An account switch/reset happened while the read was in flight: these rows
  // belong to state that was just torn down.
  if (epoch !== resumeEpoch) return

  for (const row of rows) {
    if (jobIdByAttachmentId.has(row.attachmentId)) continue

    const jobId = newJobId()
    jobIdByAttachmentId.set(row.attachmentId, jobId)
    blobs.set(jobId, row.blob)
    const failed = row.status === "failed"
    state.jobs.set(jobId, {
      jobId,
      workspaceId,
      attachmentId: row.attachmentId,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      e2e: row.e2e,
      status: failed ? "error" : "uploading",
      progress: 0,
      error: row.error,
      retryable: failed ? (row.retryable ?? true) : undefined,
      // E2E rows hold ciphertext — nothing previewable locally.
      previewUrl: row.e2e ? undefined : createPreviewUrl(row.blob, row),
      // Resumed jobs start unheld; a draft restore may claim them.
      released: true,
    })

    if (!failed) {
      const controller = new AbortController()
      controllers.set(jobId, controller)
      void uploadBytes(jobId, controller.signal)
    }
  }
  if (rows.length > 0) emit()
}

/**
 * Account switch/logout: abort live transfers and drop all in-memory state.
 * IDB rows survive (mirroring pendingMessages) so a re-login resumes them.
 */
export function resetUploadManager(): void {
  resumeEpoch++
  for (const controller of controllers.values()) controller.abort()
  controllers.clear()
  for (const job of state.jobs.values()) revokePreviewUrl(job.previewUrl)
  state.jobs.clear()
  blobs.clear()
  jobIdByAttachmentId.clear()
  resumedWorkspaces.clear()
  emit()
}
