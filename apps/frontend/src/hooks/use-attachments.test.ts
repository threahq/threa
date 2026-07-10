import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import type { ChangeEvent } from "react"
import { useAttachments } from "./use-attachments"
import { attachmentsApi } from "@/api"
import { db } from "@/db"
import * as xhrTransport from "@/lib/uploads/xhr-upload"
import { resetUploadManager, findUploadJob } from "@/lib/uploads/upload-manager"

const workspaceId = "ws_123"

function createFile(name: string, type: string, content = "test content"): File {
  return new File([content], name, { type })
}

function createChangeEvent(files: File[]): ChangeEvent<HTMLInputElement> {
  return { target: { files, value: "" } } as unknown as ChangeEvent<HTMLInputElement>
}

/** Reservation ids assigned per filename so multi-file tests are deterministic. */
const ID_BY_NAME: Record<string, string> = {
  "test.txt": "attach_123",
  "image1.png": "attach_1",
  "image2.png": "attach_2",
  "doc.pdf": "attach_3",
  "pasted.png": "attach_456",
}

function mockReserve() {
  return vi.spyOn(attachmentsApi, "reserve").mockImplementation(async (_ws, input) => {
    const id = ID_BY_NAME[input.filename] ?? "attach_generic"
    return {
      attachment: { id, filename: input.filename, mimeType: input.mimeType, sizeBytes: input.sizeBytes } as never,
      upload: { method: "POST" as const, url: `/x/${id}/content`, field: "file" as const },
    }
  })
}

describe("useAttachments", () => {
  beforeEach(async () => {
    resetUploadManager()
    await db.uploadJobs.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("send-while-uploading", () => {
    it("exposes the reserved id as attachable while the bytes are still streaming", async () => {
      mockReserve()
      let finishUpload!: () => void
      vi.spyOn(xhrTransport, "xhrUpload").mockImplementation(
        () => new Promise((resolve) => (finishUpload = () => resolve({ status: 201, body: {} })))
      )

      const { result } = renderHook(() => useAttachments(workspaceId))

      act(() => {
        result.current.handleFileSelect(createChangeEvent([createFile("test.txt", "text/plain")]))
      })

      // Reservation lands: the chip flips temp→server id but stays uploading —
      // and the id is ALREADY attachable (this is what send binds).
      await waitFor(() => {
        expect(result.current.pendingAttachments[0]?.id).toBe("attach_123")
        expect(result.current.pendingAttachments[0]?.status).toBe("uploading")
        expect(result.current.uploadedIds).toEqual(["attach_123"])
        expect(result.current.isReserving).toBe(false)
      })

      finishUpload()
      await waitFor(() => {
        expect(result.current.pendingAttachments[0]?.status).toBe("uploaded")
        expect(result.current.isUploading).toBe(false)
      })
    })

    it("clear() releases the composer's hold without aborting the transfer", async () => {
      mockReserve()
      let aborted = false
      let finishUpload!: () => void
      vi.spyOn(xhrTransport, "xhrUpload").mockImplementation(
        ({ signal }) =>
          new Promise((resolve) => {
            signal?.addEventListener("abort", () => (aborted = true))
            finishUpload = () => resolve({ status: 201, body: {} })
          })
      )

      const { result } = renderHook(() => useAttachments(workspaceId))
      act(() => {
        result.current.handleFileSelect(createChangeEvent([createFile("test.txt", "text/plain")]))
      })
      await waitFor(() => expect(result.current.uploadedIds).toEqual(["attach_123"]))

      // Message sent — the composer clears, the upload must keep going.
      act(() => result.current.clear())
      expect(result.current.pendingAttachments).toHaveLength(0)
      expect(aborted).toBe(false)
      expect(findUploadJob("attach_123")?.status).toBe("uploading")

      // The released job settles and frees itself.
      finishUpload()
      await waitFor(() => expect(findUploadJob("attach_123")).toBeUndefined())
    })

    it("blocks send only during the reservation window", async () => {
      let resolveReserve!: () => void
      vi.spyOn(attachmentsApi, "reserve").mockImplementation(
        (_ws, input) =>
          new Promise((resolve) => {
            resolveReserve = () =>
              resolve({
                attachment: { id: "attach_123", ...input } as never,
                upload: { method: "POST", url: "/x", field: "file" },
              })
          })
      )
      vi.spyOn(xhrTransport, "xhrUpload").mockResolvedValue({ status: 201, body: {} })

      const { result } = renderHook(() => useAttachments(workspaceId))
      act(() => {
        result.current.handleFileSelect(createChangeEvent([createFile("test.txt", "text/plain")]))
      })

      // No id yet — the file would be silently dropped from a send.
      await waitFor(() => expect(result.current.isReserving).toBe(true))
      expect(result.current.uploadedIds).toEqual([])

      act(() => resolveReserve())
      await waitFor(() => {
        expect(result.current.isReserving).toBe(false)
        expect(result.current.uploadedIds).toEqual(["attach_123"])
      })
    })
  })

  describe("failure handling", () => {
    it("marks the chip failed when the reservation fails and excludes it from sends", async () => {
      vi.spyOn(attachmentsApi, "reserve").mockRejectedValue(new Error("Network error"))

      const { result } = renderHook(() => useAttachments(workspaceId))
      act(() => {
        result.current.handleFileSelect(createChangeEvent([createFile("test.txt", "text/plain")]))
      })

      await waitFor(() => {
        expect(result.current.pendingAttachments[0]?.status).toBe("error")
        expect(result.current.pendingAttachments[0]?.error).toBe("Network error")
      })
      expect(result.current.hasFailed).toBe(true)
      expect(result.current.uploadedIds).toEqual([])
    })

    it("removing a failed upload deletes its leaked reservation", async () => {
      mockReserve()
      vi.spyOn(xhrTransport, "xhrUpload").mockResolvedValue({ status: 422, body: { error: "nope" } })
      vi.spyOn(attachmentsApi, "reportUploadFailure").mockResolvedValue(undefined)
      const del = vi.spyOn(attachmentsApi, "delete").mockResolvedValue(undefined)

      const { result } = renderHook(() => useAttachments(workspaceId))
      act(() => {
        result.current.handleFileSelect(createChangeEvent([createFile("test.txt", "text/plain")]))
      })
      await waitFor(() => expect(result.current.pendingAttachments[0]?.status).toBe("error"))

      act(() => result.current.removeAttachment("attach_123"))
      expect(result.current.pendingAttachments).toHaveLength(0)
      await waitFor(() => expect(del).toHaveBeenCalledWith(workspaceId, "attach_123"))
    })
  })

  describe("cancel upload", () => {
    it("aborts an in-flight upload, drops the chip, and deletes the reservation", async () => {
      mockReserve()
      const del = vi.spyOn(attachmentsApi, "delete").mockResolvedValue(undefined)
      let aborted = false
      const xhr = vi.spyOn(xhrTransport, "xhrUpload").mockImplementation(
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              aborted = true
              reject(new DOMException("Aborted", "AbortError"))
            })
          })
      )

      const { result } = renderHook(() => useAttachments(workspaceId))
      act(() => {
        result.current.handleFileSelect(createChangeEvent([createFile("test.txt", "text/plain")]))
      })
      await waitFor(() => expect(result.current.pendingAttachments[0]?.id).toBe("attach_123"))
      await waitFor(() => expect(xhr).toHaveBeenCalled())

      act(() => result.current.cancelUpload("attach_123"))

      expect(aborted).toBe(true)
      expect(result.current.pendingAttachments).toHaveLength(0)
      await waitFor(() => expect(del).toHaveBeenCalledWith(workspaceId, "attach_123"))
    })

    it("is a no-op for a settled attachment", async () => {
      mockReserve()
      vi.spyOn(xhrTransport, "xhrUpload").mockResolvedValue({ status: 201, body: {} })
      const del = vi.spyOn(attachmentsApi, "delete").mockResolvedValue(undefined)

      const { result } = renderHook(() => useAttachments(workspaceId))
      act(() => {
        result.current.handleFileSelect(createChangeEvent([createFile("test.txt", "text/plain")]))
      })
      await waitFor(() => expect(result.current.pendingAttachments[0]?.status).toBe("uploaded"))

      act(() => result.current.cancelUpload("attach_123"))

      // A settled attachment must not be silently dropped — removeAttachment is for that.
      expect(result.current.pendingAttachments).toHaveLength(1)
      expect(del).not.toHaveBeenCalled()
    })
  })

  describe("uploadFile (programmatic upload)", () => {
    it("returns as soon as the id is reserved, with a sequential image index", async () => {
      mockReserve()
      vi.spyOn(xhrTransport, "xhrUpload").mockImplementation(() => new Promise(() => {})) // bytes never finish

      const { result } = renderHook(() => useAttachments(workspaceId))

      let uploadResult: Awaited<ReturnType<typeof result.current.uploadFile>>
      await act(async () => {
        uploadResult = await result.current.uploadFile(createFile("pasted.png", "image/png"))
      })

      expect(uploadResult!.tempId).toMatch(/^temp_/)
      expect(uploadResult!.attachment).toMatchObject({ id: "attach_456", status: "uploading" })
      expect(uploadResult!.imageIndex).toBe(1)
      expect(result.current.uploadedIds).toEqual(["attach_456"])
    })

    it("returns an error attachment when the reservation fails", async () => {
      vi.spyOn(attachmentsApi, "reserve").mockRejectedValue(new Error("Network error"))

      const { result } = renderHook(() => useAttachments(workspaceId))
      let uploadResult: Awaited<ReturnType<typeof result.current.uploadFile>>
      await act(async () => {
        uploadResult = await result.current.uploadFile(createFile("pasted.png", "image/png"))
      })

      expect(uploadResult!.attachment.status).toBe("error")
      expect(uploadResult!.imageIndex).toBe(1) // index was still assigned
    })

    it("assigns sequential indices to images only", async () => {
      mockReserve()
      vi.spyOn(xhrTransport, "xhrUpload").mockResolvedValue({ status: 201, body: {} })

      const { result } = renderHook(() => useAttachments(workspaceId))
      let first: Awaited<ReturnType<typeof result.current.uploadFile>>
      let doc: Awaited<ReturnType<typeof result.current.uploadFile>>
      let second: Awaited<ReturnType<typeof result.current.uploadFile>>
      await act(async () => {
        first = await result.current.uploadFile(createFile("image1.png", "image/png"))
        doc = await result.current.uploadFile(createFile("doc.pdf", "application/pdf"))
        second = await result.current.uploadFile(createFile("image2.png", "image/png"))
      })

      expect(first!.imageIndex).toBe(1)
      expect(doc!.imageIndex).toBeNull()
      expect(second!.imageIndex).toBe(2)
    })
  })

  describe("restore", () => {
    it("re-claims a live upload job by id (draft rehydrate keeps the spinner)", async () => {
      mockReserve()
      vi.spyOn(xhrTransport, "xhrUpload").mockImplementation(() => new Promise(() => {}))

      const { result } = renderHook(() => useAttachments(workspaceId))
      act(() => {
        result.current.handleFileSelect(createChangeEvent([createFile("test.txt", "text/plain")]))
      })
      await waitFor(() => expect(result.current.pendingAttachments[0]?.id).toBe("attach_123"))

      // Rehydrate round-trip: the restore payload carries no upload state, but
      // the live job does — the chip must stay "uploading", not flip to done.
      act(() => {
        result.current.restore([{ id: "attach_123", filename: "test.txt", mimeType: "text/plain", sizeBytes: 12 }])
      })
      expect(result.current.pendingAttachments[0]).toMatchObject({ id: "attach_123", status: "uploading" })
    })

    it("falls back to inert uploaded facts for ids with no live job (reload case)", () => {
      const { result } = renderHook(() => useAttachments(workspaceId))
      act(() => {
        result.current.restore([
          { id: "attach_old", filename: "old.png", mimeType: "image/png", sizeBytes: 42 },
          { id: "attach_doc", filename: "doc.pdf", mimeType: "application/pdf", sizeBytes: 7 },
        ])
      })

      expect(result.current.pendingAttachments).toEqual([
        { id: "attach_old", filename: "old.png", mimeType: "image/png", sizeBytes: 42, status: "uploaded" },
        { id: "attach_doc", filename: "doc.pdf", mimeType: "application/pdf", sizeBytes: 7, status: "uploaded" },
      ])
      expect(result.current.uploadedIds).toEqual(["attach_old", "attach_doc"])
      expect(result.current.imageCount).toBe(1)
    })
  })

  describe("multiple files", () => {
    it("keeps an already-settled attachment when another file is added later (claim/release diffing)", async () => {
      mockReserve()
      vi.spyOn(xhrTransport, "xhrUpload").mockResolvedValue({ status: 201, body: {} })

      const { result } = renderHook(() => useAttachments(workspaceId))

      // File A: pick and let it fully settle.
      act(() => {
        result.current.handleFileSelect(createChangeEvent([createFile("image1.png", "image/png")]))
      })
      await waitFor(() => expect(result.current.pendingAttachments[0]?.status).toBe("uploaded"))

      // File B arrives as a SEPARATE pick — the held-set change must not
      // release (and thereby free) the settled job for A.
      act(() => {
        result.current.handleFileSelect(createChangeEvent([createFile("doc.pdf", "application/pdf")]))
      })
      await waitFor(() => expect(result.current.pendingAttachments).toHaveLength(2))
      expect(result.current.pendingAttachments.map((a) => a.id)).toEqual(["attach_1", "attach_3"])
      await waitFor(() => expect(result.current.uploadedIds).toEqual(["attach_1", "attach_3"]))

      // And removing B must not drop A either.
      act(() => result.current.removeAttachment("attach_3"))
      expect(result.current.pendingAttachments.map((a) => a.id)).toEqual(["attach_1"])
      expect(result.current.uploadedIds).toEqual(["attach_1"])
    })

    it("tracks each file's chip independently", async () => {
      mockReserve()
      vi.spyOn(xhrTransport, "xhrUpload").mockResolvedValue({ status: 201, body: {} })

      const { result } = renderHook(() => useAttachments(workspaceId))
      act(() => {
        result.current.handleFileSelect(
          createChangeEvent([createFile("image1.png", "image/png"), createFile("doc.pdf", "application/pdf")])
        )
      })

      await waitFor(() => {
        expect(result.current.pendingAttachments.map((a) => a.status)).toEqual(["uploaded", "uploaded"])
      })
      expect(result.current.uploadedIds).toEqual(["attach_1", "attach_3"])
    })
  })
})
