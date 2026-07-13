import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { toast } from "sonner"
import {
  claimUpload,
  findUploadJob,
  getUploadsVersion,
  releaseUploads,
  removeUpload,
  retryUpload,
  startUpload,
  subscribeUploads,
} from "@/lib/uploads/upload-manager"
import { useBindPersonaAttachment } from "@/hooks/use-personas"

/**
 * One in-flight persona-knowledge upload — a live job owned by the app-level
 * upload manager, not by this hook. Once a job settles (`uploaded`) it is bound
 * to the persona and drops out (the config-cache row replaces it), so this row
 * only ever renders the transfer or a transport failure.
 */
export interface KnowledgeUploadRow {
  jobId: string
  filename: string
  sizeBytes: number
  /** Bytes-on-the-wire fraction, 0..1. */
  progress: number
  status: "uploading" | "error"
  error?: string
}

/**
 * Drive persona-knowledge uploads through the shared composer upload transport
 * (INV-35/37): `startUpload` reserves + streams the bytes with progress/retry/
 * offline for free, then this hook binds the settled attachment to the persona.
 * The manager is module-level and its jobs outlive this component, so the
 * claim/release diff mirrors `useAttachments` (StrictMode-safe) — re-opening the
 * editor never double-claims or duplicates a row.
 */
export function usePersonaKnowledgeUploads(workspaceId: string, personaId: string) {
  const [jobIds, setJobIds] = useState<string[]>([])
  const jobIdsRef = useRef<string[]>([])
  const setJobs = useCallback((updater: (prev: string[]) => string[]) => {
    setJobIds((prev) => {
      const next = updater(prev)
      jobIdsRef.current = next
      return next
    })
  }, [])

  // Re-render on any manager change so rows track job progress live.
  useSyncExternalStore(subscribeUploads, getUploadsVersion, getUploadsVersion)

  const bind = useBindPersonaAttachment(workspaceId, personaId)
  // Keep the latest mutate off the settle effect's deps so it fires on manager
  // version changes only (not on every render). The dedupe set below is the real
  // guard against a double-bind.
  const bindMutateRef = useRef(bind.mutate)
  bindMutateRef.current = bind.mutate

  // Claim held jobs / release the ones that leave (or all on unmount), per-id
  // diffed so an unrelated add/remove never releases a survivor. Claims are
  // idempotent, so StrictMode's cleanup→re-run re-claims the same set safely.
  const claimedRef = useRef<Set<string>>(new Set())
  const heldKey = jobIds.join(",")
  useEffect(() => {
    const next = new Set(heldKey ? heldKey.split(",") : [])
    for (const id of next) claimUpload(id)
    const removed = [...claimedRef.current].filter((id) => !next.has(id))
    if (removed.length > 0) releaseUploads(removed)
    claimedRef.current = next
  }, [heldKey])
  useEffect(() => () => releaseUploads([...claimedRef.current]), [])

  // Bind each job once it settles. On success the config-cache row (seeded by the
  // mutation) replaces this pending row; on failure toast + delete the settled
  // reservation (the upload sweep never reaps a settled-but-unbound attachment).
  const boundAttemptedRef = useRef<Set<string>>(new Set())
  const version = getUploadsVersion()
  useEffect(() => {
    for (const jobId of jobIdsRef.current) {
      const job = findUploadJob(jobId)
      if (!job || job.status !== "uploaded" || !job.attachmentId) continue
      if (boundAttemptedRef.current.has(jobId)) continue
      boundAttemptedRef.current.add(jobId)
      bindMutateRef.current(job.attachmentId, {
        onSuccess: () => setJobs((prev) => prev.filter((id) => id !== jobId)),
        onError: (error: unknown) => {
          toast.error(error instanceof Error ? error.message : "Failed to add file")
          removeUpload(jobId)
          boundAttemptedRef.current.delete(jobId)
          setJobs((prev) => prev.filter((id) => id !== jobId))
        },
      })
    }
  }, [version, setJobs])

  const rows: KnowledgeUploadRow[] = jobIds.flatMap((jobId) => {
    const job = findUploadJob(jobId)
    // A settled job is bind-in-flight — hide it so it never renders alongside the
    // config-cache row the bind is about to seed.
    if (!job || job.status === "uploaded") return []
    return [
      {
        jobId,
        filename: job.filename,
        sizeBytes: job.sizeBytes,
        progress: job.progress,
        status: job.status === "error" ? ("error" as const) : ("uploading" as const),
        error: job.error,
      },
    ]
  })

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return
      const jobs = files.map((file) => startUpload(workspaceId, file))
      setJobs((prev) => [...prev, ...jobs.map((job) => job.jobId)])
    },
    [workspaceId, setJobs]
  )

  const cancel = useCallback(
    (jobId: string) => {
      removeUpload(jobId)
      setJobs((prev) => prev.filter((id) => id !== jobId))
    },
    [setJobs]
  )

  const retry = useCallback((jobId: string) => {
    void retryUpload(jobId)
  }, [])

  return { rows, addFiles, cancel, retry }
}
