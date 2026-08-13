import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ChangeEvent,
  type RefObject,
} from "react"
import { attachmentsApi } from "@/api"
import {
  startUpload,
  waitForReservation,
  removeUpload,
  releaseUploads,
  claimUpload,
  findUploadJob,
  subscribeUploads,
  getUploadsVersion,
  type UploadJob,
} from "@/lib/uploads/upload-manager"

interface UploadOptions {
  /**
   * When the destination stream is E2E, the upload manager encrypts each file
   * client-side before anything leaves the page and stashes its key/iv so the
   * send path can seal them into the message's `attachmentRefs`.
   */
  e2eEnabled?: boolean
}

export interface PendingAttachment {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  status: "uploading" | "uploaded" | "error"
  error?: string
  /** Bytes-on-the-wire fraction (0..1) while uploading. */
  progress?: number
  /**
   * Local object URL for previewable files (image/video/pdf/markdown/html/text),
   * for the in-composer preview (thumbnail + lightbox). Undefined for
   * non-previewable files and for restored drafts, which carry no local bytes.
   */
  previewUrl?: string
  /**
   * A failed upload whose bytes can be re-streamed against its reservation
   * (`retryUpload`) with a chance of succeeding. False for reservation
   * failures (nothing durable to retry against) and for terminal rejections
   * (4xx, swept reservation — the same bytes fail the same way every time);
   * remove-and-repick is the only recovery for those.
   */
  canRetry?: boolean
}

export interface UploadResult {
  /** The attachment (real id once reserved; `error` status if reservation failed) */
  attachment: PendingAttachment
  /** For images, the sequential index (1, 2, 3...). Null for non-images. */
  imageIndex: number | null
  /** Temporary ID used during upload - use this to track the node */
  tempId: string
}

export interface UseAttachmentsReturn {
  /** Current pending attachments */
  pendingAttachments: PendingAttachment[]
  /** Synchronous snapshot of attachments for submit paths that must not depend on render timing */
  getPendingAttachmentsSnapshot: () => PendingAttachment[]
  /** Ref to attach to a hidden file input */
  fileInputRef: RefObject<HTMLInputElement | null>
  /** Handler for file input change event */
  handleFileSelect: (e: ChangeEvent<HTMLInputElement>) => void
  /** Upload a file programmatically (for paste/drop). Returns once the id is reserved. */
  uploadFile: (file: File) => Promise<UploadResult>
  /** Remove an attachment by ID (aborts an in-flight upload and deletes the reservation) */
  removeAttachment: (id: string) => void
  /** Abort an in-flight upload and drop its chip. No-op for settled attachments. */
  cancelUpload: (id: string) => void
  /**
   * IDs a send may bind right now: every reserved id that hasn't failed.
   * Uploads still in flight are INCLUDED — the message binds the id and the
   * bytes finish in the background (send-while-uploading).
   */
  uploadedIds: string[]
  /** Whether any files are currently uploading (bytes still moving) */
  isUploading: boolean
  /**
   * Whether any file is still waiting for its reservation (no id yet). The
   * only upload phase that gates send — sub-second, and sending during it
   * would silently drop the file.
   */
  isReserving: boolean
  /** Whether any uploads failed */
  hasFailed: boolean
  /** Clear all attachments (releases them — in-flight uploads keep running) */
  clear: () => void
  /** Restore attachments from saved state */
  restore: (attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }>) => void
  /** Current image count for numbering */
  imageCount: number
}

/**
 * An attachment this composer holds: either a live upload job (owned by the
 * app-level upload manager — its lifetime is NOT tied to this hook), or a
 * restored draft attachment whose upload finished in some earlier session.
 */
type HeldEntry =
  | { kind: "job"; jobId: string }
  | { kind: "restored"; id: string; filename: string; mimeType: string; sizeBytes: number }

const CHIP_STATUS_BY_JOB_STATUS: Record<UploadJob["status"], PendingAttachment["status"]> = {
  reserving: "uploading",
  uploading: "uploading",
  uploaded: "uploaded",
  error: "error",
}

function jobToPending(job: UploadJob): PendingAttachment {
  return {
    id: job.attachmentId ?? job.jobId,
    filename: job.filename,
    mimeType: job.mimeType,
    sizeBytes: job.sizeBytes,
    status: CHIP_STATUS_BY_JOB_STATUS[job.status],
    error: job.error,
    progress: job.status === "uploaded" ? undefined : job.progress,
    previewUrl: job.previewUrl,
    // A terminal rejection (4xx, swept reservation) fails identically on every
    // retry — only network-class failures earn the affordance.
    canRetry: job.status === "error" && !!job.attachmentId && job.retryable !== false,
  }
}

function computePending(entries: HeldEntry[]): PendingAttachment[] {
  return entries.flatMap((entry) => {
    if (entry.kind === "restored") {
      const { kind: _kind, ...facts } = entry
      return [{ ...facts, status: "uploaded" as const }]
    }
    const job = findUploadJob(entry.jobId)
    return job ? [jobToPending(job)] : []
  })
}

/**
 * Composer-side view over the app-level upload manager. The hook tracks WHICH
 * attachments this composer holds; the manager owns the uploads themselves,
 * so clearing the composer (send) or unmounting never interrupts a transfer.
 */
export function useAttachments(workspaceId: string, options?: UploadOptions): UseAttachmentsReturn {
  const e2eEnabled = options?.e2eEnabled === true
  const [entries, setEntries] = useState<HeldEntry[]>([])
  const entriesRef = useRef<HeldEntry[]>([])
  const [imageCount, setImageCount] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const updateEntries = useCallback((updater: (prev: HeldEntry[]) => HeldEntry[]) => {
    setEntries((prev) => {
      const next = updater(prev)
      entriesRef.current = next
      return next
    })
  }, [])

  // Re-render on any manager change so chips track job state live.
  useSyncExternalStore(subscribeUploads, getUploadsVersion, getUploadsVersion)

  // getUploadsVersion() is intentionally a dependency: entries are stable
  // while the underlying jobs progress.
  const pendingAttachments = useMemo(() => computePending(entries), [entries, getUploadsVersion()])

  const getPendingAttachmentsSnapshot = useCallback(() => computePending(entriesRef.current), [])

  // Claim/release with per-id diffing: while a composer holds a job the
  // manager keeps its resources; a job is released only when it LEAVES the
  // held set (or the composer unmounts) — the transfer keeps running and
  // frees itself when it settles. The diff matters: releasing the whole
  // previous set on every entries change would free any already-settled job
  // during an unrelated add/remove, silently dropping a finished attachment
  // from the composer. Claims are idempotent, so re-claiming survivors (and
  // StrictMode's cleanup→re-run) is safe.
  const heldJobIdsKey = entries.flatMap((e) => (e.kind === "job" ? [e.jobId] : [])).join(",")
  const claimedJobIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const next = new Set(heldJobIdsKey ? heldJobIdsKey.split(",") : [])
    for (const id of next) claimUpload(id)
    const removed = [...claimedJobIdsRef.current].filter((id) => !next.has(id))
    if (removed.length > 0) releaseUploads(removed)
    claimedJobIdsRef.current = next
  }, [heldJobIdsKey])
  // Unmount: release everything still held. StrictMode's simulated unmount
  // runs this too, but the claim effect re-runs immediately after (same
  // commit, nothing can settle in between) and re-claims the same set.
  useEffect(
    () => () => {
      releaseUploads([...claimedJobIdsRef.current])
    },
    []
  )

  const handleFileSelect = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      // Convert to array before resetting value — Chrome clears the FileList in-place
      // when input.value is reset, so the reference would be empty if captured after.
      const files = Array.from(e.target.files ?? [])
      if (files.length === 0) return

      // Reset input so same file can be selected again
      e.target.value = ""

      const jobs = files.map((file) => startUpload(workspaceId, file, { e2e: e2eEnabled }))
      updateEntries((prev) => [...prev, ...jobs.map((job) => ({ kind: "job" as const, jobId: job.jobId }))])
    },
    [updateEntries, workspaceId, e2eEnabled]
  )

  // Use ref to track image count synchronously for proper indexing
  const imageCountRef = useRef(imageCount)
  imageCountRef.current = imageCount

  const uploadFile = useCallback(
    async (file: File): Promise<UploadResult> => {
      const isImage = file.type.startsWith("image/")
      let assignedImageIndex: number | null = null

      // Assign the image index off the synchronous ref, not state, so back-to-back
      // uploads in one tick get distinct sequential indices.
      if (isImage) {
        assignedImageIndex = imageCountRef.current + 1
        imageCountRef.current = assignedImageIndex
        setImageCount(assignedImageIndex)
      }

      const job = startUpload(workspaceId, file, { e2e: e2eEnabled })
      updateEntries((prev) => [...prev, { kind: "job", jobId: job.jobId }])

      // Resolves as soon as the reservation lands (the id is usable in the
      // editor node immediately) — NOT when the bytes finish.
      const reserved = await waitForReservation(job.jobId)
      return {
        attachment: jobToPending(reserved),
        imageIndex: assignedImageIndex,
        tempId: job.jobId,
      }
    },
    [updateEntries, workspaceId, e2eEnabled]
  )

  const removeAttachment = useCallback(
    (attachmentId: string) => {
      const entry = entriesRef.current.find((e) =>
        e.kind === "job"
          ? e.jobId === attachmentId || findUploadJob(e.jobId)?.attachmentId === attachmentId
          : e.id === attachmentId
      )
      if (!entry) return

      updateEntries((prev) => prev.filter((e) => e !== entry))

      if (entry.kind === "job") {
        // Aborts an in-flight transfer and best-effort deletes the reservation.
        removeUpload(entry.jobId)
        return
      }
      attachmentsApi.delete(workspaceId, entry.id).catch((err) => {
        console.warn("Failed to delete attachment from server:", err)
      })
    },
    [updateEntries, workspaceId]
  )

  // The × on an uploading chip: same cleanup as remove, gated to in-flight
  // uploads so a mis-targeted call can't drop a settled attachment.
  const cancelUpload = useCallback(
    (id: string) => {
      const job = findUploadJob(id)
      if (!job || job.status === "uploaded") return
      removeAttachment(id)
    },
    [removeAttachment]
  )

  // Releasing (not aborting!) is what makes send-while-uploading work: the
  // message already bound the reserved ids, so the bytes must keep streaming
  // after the composer clears. The claim/release effect above handles the
  // manager side when `entries` empties.
  const clear = useCallback(() => {
    entriesRef.current = []
    setEntries([])
    setImageCount(0)
    imageCountRef.current = 0
  }, [])

  const restore = useCallback(
    (attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }>) => {
      // Prefer the live upload job when one exists (same-session rehydrate, or
      // a resumed-after-reload transfer): it carries real status, progress and
      // the local preview. Only job-less attachments fall back to inert
      // "uploaded" facts from the draft.
      const restored: HeldEntry[] = attachments.map((a) => {
        const job = claimUpload(a.id)
        return job ? { kind: "job" as const, jobId: job.jobId } : { kind: "restored" as const, ...a }
      })
      // MERGE with what this composer already holds, never replace: the draft
      // persists ids as their reservations arrive, and its own write-back
      // re-read can restore mid-batch — evicting the jobs still waiting for
      // their ids silently dropped every not-yet-reserved file of a multi-pick.
      // Scope changes clear the entries before restoring, so kept entries are
      // always this scope's own in-flight work.
      const restoredIds = new Set(attachments.map((a) => a.id))
      const restoredJobIds = new Set(restored.flatMap((e) => (e.kind === "job" ? [e.jobId] : [])))
      const kept = entriesRef.current.filter((entry) => {
        if (entry.kind === "restored") return !restoredIds.has(entry.id)
        if (restoredJobIds.has(entry.jobId)) return false
        const jobAttachmentId = findUploadJob(entry.jobId)?.attachmentId
        return jobAttachmentId === null || jobAttachmentId === undefined || !restoredIds.has(jobAttachmentId)
      })
      const next = [...restored, ...kept]
      entriesRef.current = next
      setEntries(next)
      const mergedImageCount = next.filter((entry) => {
        const mimeType = entry.kind === "restored" ? entry.mimeType : findUploadJob(entry.jobId)?.mimeType
        return mimeType?.startsWith("image/") === true
      }).length
      setImageCount(mergedImageCount)
      imageCountRef.current = mergedImageCount
    },
    []
  )

  const uploadedIds = pendingAttachments
    .filter((a) => a.status !== "error" && !a.id.startsWith("temp_"))
    .map((a) => a.id)

  const isUploading = pendingAttachments.some((a) => a.status === "uploading")
  const isReserving = entries.some((e) => e.kind === "job" && findUploadJob(e.jobId)?.status === "reserving")
  const hasFailed = pendingAttachments.some((a) => a.status === "error")

  return {
    pendingAttachments,
    getPendingAttachmentsSnapshot,
    fileInputRef,
    handleFileSelect,
    uploadFile,
    removeAttachment,
    cancelUpload,
    uploadedIds,
    isUploading,
    isReserving,
    hasFailed,
    clear,
    restore,
    imageCount,
  }
}
