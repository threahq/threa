import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { attachmentsApi } from "@/api"
import { ApiError } from "@/api/client"
import { db } from "@/db"
import { getAttachmentRef, clearAttachmentRefCache } from "@/lib/crypto/attachment-crypto"
import * as xhrTransport from "./xhr-upload"
import { XhrNetworkError } from "./xhr-upload"
import {
  startUpload,
  waitForReservation,
  removeUpload,
  releaseUploads,
  retryUpload,
  resumeWorkspaceUploads,
  resetUploadManager,
  findUploadJob,
  getUploadJobByAttachmentId,
  subscribeUploads,
} from "./upload-manager"

const WS = "ws_test"

function makeFile(name = "doc.txt", content = "hello world", type = "text/plain"): File {
  return new File([content], name, { type })
}

function mockReserve(id = "attach_1") {
  return vi.spyOn(attachmentsApi, "reserve").mockImplementation(async (_ws, input) => ({
    attachment: {
      id,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      safetyStatus: "pending_upload",
    } as never,
    upload: { method: "POST" as const, url: `/api/workspaces/${WS}/attachments/${id}/content`, field: "file" as const },
  }))
}

/** Wait until the job for `id` reaches `status` (or disappears when null). */
function waitForJobStatus(id: string, status: string | null): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const job = findUploadJob(id)
      if (status === null ? !job : job?.status === status) {
        unsubscribe()
        resolve()
      }
    }
    const unsubscribe = subscribeUploads(check)
    check()
  })
}

describe("upload-manager", () => {
  beforeEach(async () => {
    resetUploadManager()
    clearAttachmentRefCache()
    await db.uploadJobs.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("reserves an id, persists the job, streams the bytes, and settles", async () => {
    mockReserve("attach_ok")
    const xhr = vi.spyOn(xhrTransport, "xhrUpload").mockImplementation(async ({ onProgress }) => {
      onProgress?.(0.5)
      onProgress?.(1)
      return { status: 201, body: { attachment: { id: "attach_ok" } } }
    })

    const job = startUpload(WS, makeFile())
    expect(job.status).toBe("reserving")

    const reserved = await waitForReservation(job.jobId)
    expect(reserved.attachmentId).toBe("attach_ok")
    expect(reserved.status).toBe("uploading")
    // Durable from reservation on — a reload would resume this transfer.
    expect(await db.uploadJobs.get("attach_ok")).toMatchObject({ workspaceId: WS, status: "pending" })

    await waitForJobStatus(job.jobId, "uploaded")
    expect(xhr).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining(`/attachments/attach_ok/content`) })
    )
    // Settled: nothing left to resume.
    expect(await db.uploadJobs.get("attach_ok")).toBeUndefined()
  })

  it("a released job keeps uploading and frees itself when it settles (send-while-uploading)", async () => {
    mockReserve("attach_sent")
    let finishUpload!: () => void
    const xhr = vi.spyOn(xhrTransport, "xhrUpload").mockImplementation(
      ({ signal }) =>
        new Promise((resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
          finishUpload = () => resolve({ status: 201, body: {} })
        })
    )

    const job = startUpload(WS, makeFile())
    await waitForReservation(job.jobId)

    await vi.waitFor(() => expect(xhr).toHaveBeenCalledTimes(1))

    // The composer sent the message and cleared — the transfer must survive.
    releaseUploads([job.jobId])
    expect(findUploadJob(job.jobId)?.status).toBe("uploading")

    finishUpload()
    await waitForJobStatus(job.jobId, null)
    expect(getUploadJobByAttachmentId("attach_sent")).toBeUndefined()
  })

  it("cancel aborts the transfer and deletes the reservation", async () => {
    mockReserve("attach_cancel")
    const del = vi.spyOn(attachmentsApi, "delete").mockResolvedValue(undefined)
    let aborted = false
    vi.spyOn(xhrTransport, "xhrUpload").mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true
            reject(new DOMException("Aborted", "AbortError"))
          })
        })
    )

    const job = startUpload(WS, makeFile())
    await waitForReservation(job.jobId)
    await vi.waitFor(() => expect(aborted || xhrTransport.xhrUpload !== undefined).toBe(true))
    // Wait until the transfer actually started before cancelling.
    await vi.waitFor(() => expect(vi.mocked(xhrTransport.xhrUpload)).toHaveBeenCalledTimes(1))

    removeUpload("attach_cancel")
    expect(aborted).toBe(true)
    expect(findUploadJob("attach_cancel")).toBeUndefined()
    await vi.waitFor(async () => {
      expect(del).toHaveBeenCalledWith(WS, "attach_cancel")
      expect(await db.uploadJobs.get("attach_cancel")).toBeUndefined()
    })
  })

  it("cancel landing during the reserve/persist window leaves no orphaned reservation or IDB row", async () => {
    const del = vi.spyOn(attachmentsApi, "delete").mockResolvedValue(undefined)
    vi.spyOn(xhrTransport, "xhrUpload").mockResolvedValue({ status: 201, body: {} })
    let jobId!: string
    vi.spyOn(attachmentsApi, "reserve").mockImplementation(async (_ws, input) => {
      // The × lands while the reservation round-trip is still in flight — the
      // job carries no attachmentId yet, so removeUpload can't clean up the
      // durable bits; the in-flight flow must undo them itself. (The tick
      // defer lets startUpload return first so the test knows the jobId.)
      await new Promise((r) => setTimeout(r, 0))
      removeUpload(jobId)
      return {
        attachment: { id: "attach_orphan", ...input } as never,
        upload: { method: "POST" as const, url: "/x", field: "file" as const },
      }
    })

    const job = startUpload(WS, makeFile())
    jobId = job.jobId

    await vi.waitFor(async () => {
      expect(del).toHaveBeenCalledWith(WS, "attach_orphan")
      expect(await db.uploadJobs.get("attach_orphan")).toBeUndefined()
    })
    // Nothing to resume: a reload must not resurrect the cancelled upload.
    await resumeWorkspaceUploads(WS)
    expect(getUploadJobByAttachmentId("attach_orphan")).toBeUndefined()
  })

  it("a malware-blocked verdict frees the local job so the summary state drives the chip", async () => {
    mockReserve("attach_blocked")
    vi.spyOn(xhrTransport, "xhrUpload").mockResolvedValue({
      status: 400,
      body: { error: "Attachment is quarantined due to malware scan", code: "attachment_blocked" },
    })
    const report = vi.spyOn(attachmentsApi, "reportUploadFailure").mockResolvedValue(undefined)

    const job = startUpload(WS, makeFile())
    await waitForJobStatus(job.jobId, null)

    // No local job left: the chip falls through to the message summary
    // ("Blocked by malware scan") — identical to every other viewer, with no
    // retryable-looking "Upload failed" on the uploader's own device.
    expect(getUploadJobByAttachmentId("attach_blocked")).toBeUndefined()
    expect(await db.uploadJobs.get("attach_blocked")).toBeUndefined()
    expect(report).not.toHaveBeenCalled()
  })

  it("a terminal rejection marks the job failed, persists it, and reports to the server", async () => {
    mockReserve("attach_fail")
    vi.spyOn(xhrTransport, "xhrUpload").mockResolvedValue({ status: 400, body: { error: "size mismatch" } })
    const report = vi.spyOn(attachmentsApi, "reportUploadFailure").mockResolvedValue(undefined)

    const job = startUpload(WS, makeFile())
    await waitForJobStatus(job.jobId, "error")

    expect(findUploadJob(job.jobId)?.error).toBe("size mismatch")
    // Failure is durable (resume shows it as failed) and server-visible
    // (viewers of a message that bound the id see "Upload failed").
    expect(await db.uploadJobs.get("attach_fail")).toMatchObject({ status: "failed" })
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(WS, "attach_fail", "size mismatch"))
  })

  it("network errors retry with backoff and can still succeed", async () => {
    vi.useFakeTimers()
    mockReserve("attach_retry")
    const xhr = vi
      .spyOn(xhrTransport, "xhrUpload")
      .mockRejectedValueOnce(new XhrNetworkError())
      .mockResolvedValueOnce({ status: 201, body: {} })

    const job = startUpload(WS, makeFile())
    await vi.waitFor(() => expect(xhr).toHaveBeenCalledTimes(1))

    await vi.advanceTimersByTimeAsync(2_000)
    await vi.waitFor(() => expect(xhr).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(findUploadJob(job.jobId)?.status).toBe("uploaded"))
  })

  it("waits out a 429 on the byte stream and succeeds — pacing, not failure", async () => {
    vi.useFakeTimers()
    mockReserve("attach_paced")
    const xhr = vi
      .spyOn(xhrTransport, "xhrUpload")
      .mockResolvedValueOnce({ status: 429, body: { error: "Rate limit exceeded" } })
      .mockResolvedValueOnce({ status: 429, body: { error: "Rate limit exceeded" } })
      .mockResolvedValueOnce({ status: 201, body: {} })

    const job = startUpload(WS, makeFile())
    await vi.waitFor(() => expect(xhr).toHaveBeenCalledTimes(1))

    // The rate-limit schedule (5s, then 15s) — deliberately longer than the
    // whole network backoff, which a 429 must not consume.
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => expect(xhr).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(15_000)
    await vi.waitFor(() => expect(findUploadJob(job.jobId)?.status).toBe("uploaded"))
  })

  it("429 exhaustion goes terminal but keeps the retry affordance — the bytes are fine", async () => {
    vi.useFakeTimers()
    mockReserve("attach_limited")
    vi.spyOn(attachmentsApi, "reportUploadFailure").mockResolvedValue(undefined)
    vi.spyOn(xhrTransport, "xhrUpload").mockResolvedValue({ status: 429, body: { error: "Rate limit exceeded" } })

    const job = startUpload(WS, makeFile())
    await vi.waitFor(() => expect(findUploadJob(job.jobId)?.status).toBe("uploading"))
    await vi.advanceTimersByTimeAsync(200_000) // exhaust 5/15/30/60/60
    await vi.waitFor(() => expect(findUploadJob(job.jobId)?.status).toBe("error"))

    expect(findUploadJob(job.jobId)).toMatchObject({ error: "Rate limit exceeded", retryable: true })
  })

  it("a rate-limited reservation waits in place instead of stranding the file without an id", async () => {
    vi.useFakeTimers()
    const reserve = vi
      .spyOn(attachmentsApi, "reserve")
      .mockRejectedValueOnce(new ApiError(429, "rate_limited", "Rate limit exceeded"))
      .mockImplementation(async (_ws, input) => ({
        attachment: { id: "attach_waited", filename: input.filename } as never,
        upload: { method: "POST" as const, url: "/x", field: "file" as const },
      }))
    vi.spyOn(xhrTransport, "xhrUpload").mockResolvedValue({ status: 201, body: {} })

    const job = startUpload(WS, makeFile())
    await vi.waitFor(() => expect(reserve).toHaveBeenCalledTimes(1))
    expect(findUploadJob(job.jobId)?.status).toBe("reserving")

    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => expect(findUploadJob(job.jobId)?.attachmentId).toBe("attach_waited"))
    await vi.waitFor(() => expect(findUploadJob(job.jobId)?.status).toBe("uploaded"))
  })

  it("caps concurrent byte streams at three; the rest queue and start as slots free", async () => {
    let nextId = 0
    vi.spyOn(attachmentsApi, "reserve").mockImplementation(async (_ws, input) => ({
      attachment: { id: `attach_q${++nextId}`, filename: input.filename } as never,
      upload: { method: "POST" as const, url: "/x", field: "file" as const },
    }))
    const settlers: Array<() => void> = []
    const xhr = vi.spyOn(xhrTransport, "xhrUpload").mockImplementation(
      () =>
        new Promise((resolve) => {
          settlers.push(() => resolve({ status: 201, body: {} }))
        })
    )

    const jobs = Array.from({ length: 5 }, () => startUpload(WS, makeFile()))
    for (const job of jobs) await waitForReservation(job.jobId)

    // All five are reserved (send can bind every id), but only three stream.
    await vi.waitFor(() => expect(xhr).toHaveBeenCalledTimes(3))
    expect(settlers).toHaveLength(3)

    settlers.shift()!()
    await vi.waitFor(() => expect(xhr).toHaveBeenCalledTimes(4))
    settlers.shift()!()
    await vi.waitFor(() => expect(xhr).toHaveBeenCalledTimes(5))
    while (settlers.length > 0) settlers.shift()!()
    for (const job of jobs) await waitForJobStatus(job.jobId, "uploaded")
  })

  it("a duplicate-completion loser (404 but settled server-side) resolves as success", async () => {
    mockReserve("attach_dup")
    // Another tab/device won the duplicate completion: this tab's POST 404s
    // (tracking row deleted at settle), but the attachment IS downloadable.
    vi.spyOn(xhrTransport, "xhrUpload").mockResolvedValue({ status: 404, body: { error: "reservation not found" } })
    vi.spyOn(attachmentsApi, "getDownloadUrl").mockResolvedValue("https://example.com/settled")
    const report = vi.spyOn(attachmentsApi, "reportUploadFailure").mockResolvedValue(undefined)

    const job = startUpload(WS, makeFile())
    await waitForJobStatus(job.jobId, "uploaded")

    expect(findUploadJob(job.jobId)?.status).toBe("uploaded")
    expect(report).not.toHaveBeenCalled()
    expect(await db.uploadJobs.get("attach_dup")).toBeUndefined()
  })

  it("network-failed jobs auto-heal when connectivity returns (online event)", async () => {
    vi.useFakeTimers()
    mockReserve("attach_heal")
    vi.spyOn(attachmentsApi, "reportUploadFailure").mockResolvedValue(undefined)
    const xhr = vi.spyOn(xhrTransport, "xhrUpload").mockRejectedValue(new XhrNetworkError()) // every quick retry fails
    const job = startUpload(WS, makeFile())
    await vi.waitFor(() => expect(xhr).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(30_000) // exhaust 2s/5s/15s backoff
    await vi.waitFor(() => expect(findUploadJob(job.jobId)?.status).toBe("error"))
    expect(findUploadJob(job.jobId)?.retryable).toBe(true)
    vi.useRealTimers()

    // The tunnel ends: connectivity returns and the job heals itself.
    xhr.mockResolvedValue({ status: 201, body: {} })
    window.dispatchEvent(new Event("online"))
    await vi.waitFor(() => expect(findUploadJob(job.jobId)?.status).toBe("uploaded"))
  })

  it("a 4xx rejection is NOT auto-retried on reconnect", async () => {
    mockReserve("attach_terminal")
    vi.spyOn(attachmentsApi, "reportUploadFailure").mockResolvedValue(undefined)
    const xhr = vi.spyOn(xhrTransport, "xhrUpload").mockResolvedValue({ status: 422, body: { error: "nope" } })
    const job = startUpload(WS, makeFile())
    await waitForJobStatus(job.jobId, "error")
    expect(findUploadJob(job.jobId)?.retryable).toBe(false)

    const callsBefore = xhr.mock.calls.length
    window.dispatchEvent(new Event("online"))
    await new Promise((r) => setTimeout(r, 50))
    expect(xhr.mock.calls.length).toBe(callsBefore)
  })

  it("retryUpload restarts a failed job from its locally-held bytes", async () => {
    mockReserve("attach_manual_retry")
    vi.spyOn(attachmentsApi, "reportUploadFailure").mockResolvedValue(undefined)
    const xhr = vi
      .spyOn(xhrTransport, "xhrUpload")
      .mockResolvedValueOnce({ status: 422, body: { error: "nope" } })
      .mockResolvedValueOnce({ status: 201, body: {} })

    const job = startUpload(WS, makeFile())
    await waitForJobStatus(job.jobId, "error")

    await retryUpload("attach_manual_retry")
    await waitForJobStatus(job.jobId, "uploaded")
    expect(xhr).toHaveBeenCalledTimes(2)
  })

  it("resumes persisted jobs after a reload: pending and retryably-failed rows restart, terminal ones stay dead", async () => {
    const xhr = vi.spyOn(xhrTransport, "xhrUpload").mockResolvedValue({ status: 201, body: {} })
    const row = (
      attachmentId: string,
      filename: string,
      extra: { status: "pending" | "failed"; error?: string; retryable?: boolean }
    ) => ({
      attachmentId,
      workspaceId: WS,
      filename,
      mimeType: "text/plain",
      sizeBytes: 4,
      e2e: false,
      blob: new Blob(["data"], { type: "text/plain" }),
      createdAt: Date.now(),
      ...extra,
    })
    await db.uploadJobs.bulkPut([
      row("attach_resume", "resume.txt", { status: "pending" }),
      // Network-class failure from a previous session (an app kill mid-stream):
      // reopening IS the back-online moment, so it restarts like a pending row.
      // A legacy row without the flag gets the same benefit of the doubt.
      row("attach_heal", "heal.txt", { status: "failed", error: "Network error during upload", retryable: true }),
      row("attach_legacy", "legacy.txt", { status: "failed", error: "Network error during upload" }),
      row("attach_dead", "dead.txt", { status: "failed", error: "size mismatch", retryable: false }),
    ])

    await resumeWorkspaceUploads(WS)

    await vi.waitFor(() => {
      const urls = xhr.mock.calls.map((call) => call[0].url)
      expect(urls).toHaveLength(3)
      expect(urls).toEqual(
        expect.arrayContaining([
          expect.stringContaining("/attachments/attach_resume/content"),
          expect.stringContaining("/attachments/attach_heal/content"),
          expect.stringContaining("/attachments/attach_legacy/content"),
        ])
      )
    })
    const dead = getUploadJobByAttachmentId("attach_dead")
    expect(dead).toMatchObject({ status: "error", error: "size mismatch", retryable: false })
    await vi.waitFor(async () => expect(await db.uploadJobs.get("attach_resume")).toBeUndefined())
  })

  it("E2E: encrypts before reserving, declares the ciphertext size, and keeps the key in the memory bridge", async () => {
    const reserve = mockReserve("attach_e2e")
    vi.spyOn(xhrTransport, "xhrUpload").mockResolvedValue({ status: 201, body: {} })

    const plaintext = "super secret plans"
    const job = startUpload(WS, makeFile("plans.txt", plaintext), { e2e: true })
    await waitForJobStatus(job.jobId, "uploaded")

    const input = reserve.mock.calls[0][1]
    expect(input.e2e).toBe(true)
    expect(input.filename).toBe("encrypted")
    // AES-GCM ciphertext (plaintext + tag) — never the plaintext length.
    expect(input.sizeBytes).toBeGreaterThan(plaintext.length)

    // The IDB copy is ciphertext, the ref bridge holds the key + real facts.
    const row = await db.uploadJobs.get("attach_e2e")
    expect(row).toBeUndefined() // settled — deleted
    const ref = getAttachmentRef("attach_e2e")
    expect(ref).toMatchObject({ filename: "plans.txt", sizeBytes: plaintext.length })
  })
})
