import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useAttachments } from "./use-attachments"
import { attachmentsApi } from "@/api"

const mockUpload = vi.fn()
const mockDelete = vi.fn()

describe("useAttachments", () => {
  const workspaceId = "ws_123"

  beforeEach(() => {
    vi.restoreAllMocks()
    mockUpload.mockReset()
    mockDelete.mockReset()
    vi.spyOn(attachmentsApi, "upload").mockImplementation((...args: Parameters<typeof attachmentsApi.upload>) =>
      mockUpload(...args)
    )
    vi.spyOn(attachmentsApi, "delete").mockImplementation((...args: Parameters<typeof attachmentsApi.delete>) =>
      mockDelete(...args)
    )
  })

  function createFile(name: string, type: string, size: number = 1024): File {
    const content = new Array(size).fill("a").join("")
    return new File([content], name, { type })
  }

  function createChangeEvent(files: File[]): React.ChangeEvent<HTMLInputElement> {
    const fileList = {
      length: files.length,
      item: (index: number) => files[index] ?? null,
      [Symbol.iterator]: function* () {
        for (const file of files) yield file
      },
    } as FileList
    files.forEach((file, i) => {
      Object.defineProperty(fileList, i, { value: file, enumerable: true })
    })

    return {
      target: {
        files: fileList,
        value: "",
      },
    } as unknown as React.ChangeEvent<HTMLInputElement>
  }

  describe("file upload", () => {
    it("should add file as uploading then update to uploaded on success", async () => {
      mockUpload.mockResolvedValue({
        id: "attach_123",
        filename: "test.txt",
        mimeType: "text/plain",
        sizeBytes: 1024,
      })

      const { result } = renderHook(() => useAttachments(workspaceId))

      const file = createFile("test.txt", "text/plain")

      await act(async () => {
        await result.current.handleFileSelect(createChangeEvent([file]))
      })

      await waitFor(() => {
        expect(result.current.pendingAttachments).toHaveLength(1)
        expect(result.current.pendingAttachments[0]).toMatchObject({
          id: "attach_123",
          filename: "test.txt",
          status: "uploaded",
        })
      })

      expect(result.current.uploadedIds).toContain("attach_123")
      expect(result.current.isUploading).toBe(false)
      expect(result.current.hasFailed).toBe(false)
    })

    it("should mark attachment as error on upload failure", async () => {
      mockUpload.mockRejectedValue(new Error("Upload failed"))

      const { result } = renderHook(() => useAttachments(workspaceId))

      const file = createFile("test.txt", "text/plain")

      await act(async () => {
        await result.current.handleFileSelect(createChangeEvent([file]))
      })

      await waitFor(() => {
        expect(result.current.pendingAttachments).toHaveLength(1)
        expect(result.current.pendingAttachments[0].status).toBe("error")
        expect(result.current.pendingAttachments[0].error).toBe("Upload failed")
      })

      expect(result.current.hasFailed).toBe(true)
      expect(result.current.uploadedIds).toHaveLength(0)
    })

    it("should handle multiple files with mixed success/failure", async () => {
      mockUpload
        .mockResolvedValueOnce({
          id: "attach_1",
          filename: "success.txt",
          mimeType: "text/plain",
          sizeBytes: 100,
        })
        .mockRejectedValueOnce(new Error("Failed"))

      const { result } = renderHook(() => useAttachments(workspaceId))

      const file1 = createFile("success.txt", "text/plain", 100)
      const file2 = createFile("fail.txt", "text/plain", 100)

      await act(async () => {
        await result.current.handleFileSelect(createChangeEvent([file1, file2]))
      })

      await waitFor(() => {
        expect(result.current.pendingAttachments).toHaveLength(2)
      })

      const uploaded = result.current.pendingAttachments.find((a) => a.status === "uploaded")
      const failed = result.current.pendingAttachments.find((a) => a.status === "error")

      expect(uploaded?.filename).toBe("success.txt")
      expect(failed?.filename).toBe("fail.txt")
      expect(result.current.hasFailed).toBe(true)
      expect(result.current.uploadedIds).toEqual(["attach_1"])
    })
  })

  describe("remove attachment", () => {
    it("should remove attachment from pending list", async () => {
      mockUpload.mockResolvedValue({
        id: "attach_123",
        filename: "test.txt",
        mimeType: "text/plain",
        sizeBytes: 1024,
      })

      const { result } = renderHook(() => useAttachments(workspaceId))

      await act(async () => {
        await result.current.handleFileSelect(createChangeEvent([createFile("test.txt", "text/plain")]))
      })

      await waitFor(() => {
        expect(result.current.pendingAttachments).toHaveLength(1)
      })

      await act(async () => {
        await result.current.removeAttachment("attach_123")
      })

      expect(result.current.pendingAttachments).toHaveLength(0)
      expect(mockDelete).toHaveBeenCalledWith(workspaceId, "attach_123")
    })

    it("should not call delete API for failed uploads", async () => {
      mockUpload.mockRejectedValue(new Error("Failed"))

      const { result } = renderHook(() => useAttachments(workspaceId))

      await act(async () => {
        await result.current.handleFileSelect(createChangeEvent([createFile("test.txt", "text/plain")]))
      })

      await waitFor(() => {
        expect(result.current.pendingAttachments).toHaveLength(1)
        expect(result.current.pendingAttachments[0].status).toBe("error")
      })

      const tempId = result.current.pendingAttachments[0].id

      await act(async () => {
        await result.current.removeAttachment(tempId)
      })

      expect(result.current.pendingAttachments).toHaveLength(0)
      expect(mockDelete).not.toHaveBeenCalled()
    })
  })

  describe("clear", () => {
    it("should remove all pending attachments", async () => {
      mockUpload.mockResolvedValue({
        id: "attach_123",
        filename: "test.txt",
        mimeType: "text/plain",
        sizeBytes: 1024,
      })

      const { result } = renderHook(() => useAttachments(workspaceId))

      await act(async () => {
        await result.current.handleFileSelect(createChangeEvent([createFile("test.txt", "text/plain")]))
      })

      await waitFor(() => {
        expect(result.current.pendingAttachments).toHaveLength(1)
      })

      act(() => {
        result.current.clear()
      })

      expect(result.current.pendingAttachments).toHaveLength(0)
    })
  })

  describe("restore", () => {
    it("should populate attachments from saved state", () => {
      const { result } = renderHook(() => useAttachments(workspaceId))

      const savedAttachments = [
        { id: "attach_1", filename: "file1.txt", mimeType: "text/plain", sizeBytes: 100 },
        { id: "attach_2", filename: "file2.txt", mimeType: "text/plain", sizeBytes: 200 },
      ]

      act(() => {
        result.current.restore(savedAttachments)
      })

      expect(result.current.pendingAttachments).toHaveLength(2)
      expect(result.current.pendingAttachments[0]).toMatchObject({
        id: "attach_1",
        filename: "file1.txt",
        status: "uploaded",
      })
      expect(result.current.pendingAttachments[1]).toMatchObject({
        id: "attach_2",
        filename: "file2.txt",
        status: "uploaded",
      })
      expect(result.current.uploadedIds).toEqual(["attach_1", "attach_2"])
    })

    it("should restore image count for proper numbering", () => {
      const { result } = renderHook(() => useAttachments(workspaceId))

      const savedAttachments = [
        { id: "attach_1", filename: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 100 },
        { id: "attach_2", filename: "doc.pdf", mimeType: "application/pdf", sizeBytes: 200 },
        { id: "attach_3", filename: "screenshot.png", mimeType: "image/png", sizeBytes: 300 },
      ]

      act(() => {
        result.current.restore(savedAttachments)
      })

      // Image count should be 2 (two images: photo.jpg and screenshot.png)
      expect(result.current.imageCount).toBe(2)
    })
  })

  describe("uploadFile (programmatic upload)", () => {
    it("should upload a file and return result with tempId", async () => {
      mockUpload.mockResolvedValue({
        id: "attach_456",
        filename: "pasted.png",
        mimeType: "image/png",
        sizeBytes: 2048,
      })

      const { result } = renderHook(() => useAttachments(workspaceId))

      const file = createFile("pasted.png", "image/png", 2048)

      let uploadResult: Awaited<ReturnType<typeof result.current.uploadFile>>

      await act(async () => {
        uploadResult = await result.current.uploadFile(file)
      })

      expect(uploadResult!.tempId).toMatch(/^temp_/)
      expect(uploadResult!.attachment).toMatchObject({
        id: "attach_456",
        filename: "pasted.png",
        status: "uploaded",
      })
      expect(uploadResult!.imageIndex).toBe(1) // First image

      expect(result.current.pendingAttachments).toHaveLength(1)
      expect(result.current.pendingAttachments[0].id).toBe("attach_456")
      expect(result.current.getPendingAttachmentsSnapshot()).toEqual(result.current.pendingAttachments)
    })

    it("should assign sequential image indices for images", async () => {
      mockUpload
        .mockResolvedValueOnce({
          id: "attach_1",
          filename: "image1.png",
          mimeType: "image/png",
          sizeBytes: 1000,
        })
        .mockResolvedValueOnce({
          id: "attach_2",
          filename: "document.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2000,
        })
        .mockResolvedValueOnce({
          id: "attach_3",
          filename: "image2.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 3000,
        })

      const { result } = renderHook(() => useAttachments(workspaceId))

      let result1: Awaited<ReturnType<typeof result.current.uploadFile>>
      let result2: Awaited<ReturnType<typeof result.current.uploadFile>>
      let result3: Awaited<ReturnType<typeof result.current.uploadFile>>

      await act(async () => {
        result1 = await result.current.uploadFile(createFile("image1.png", "image/png", 1000))
        result2 = await result.current.uploadFile(createFile("document.pdf", "application/pdf", 2000))
        result3 = await result.current.uploadFile(createFile("image2.jpg", "image/jpeg", 3000))
      })

      // Images get sequential indices
      expect(result1!.imageIndex).toBe(1)
      expect(result2!.imageIndex).toBeNull() // PDF is not an image
      expect(result3!.imageIndex).toBe(2) // Second image

      expect(result.current.imageCount).toBe(2)
    })

    it("should return error result on upload failure", async () => {
      mockUpload.mockRejectedValue(new Error("Network error"))

      const { result } = renderHook(() => useAttachments(workspaceId))

      const file = createFile("failed.png", "image/png")

      let uploadResult: Awaited<ReturnType<typeof result.current.uploadFile>>

      await act(async () => {
        uploadResult = await result.current.uploadFile(file)
      })

      expect(uploadResult!.attachment.status).toBe("error")
      expect(uploadResult!.attachment.error).toBe("Network error")
      expect(uploadResult!.imageIndex).toBe(1) // Image index was still assigned

      expect(result.current.hasFailed).toBe(true)
    })

    it("should reset image count on clear", async () => {
      mockUpload.mockResolvedValue({
        id: "attach_1",
        filename: "image.png",
        mimeType: "image/png",
        sizeBytes: 1000,
      })

      const { result } = renderHook(() => useAttachments(workspaceId))

      await act(async () => {
        await result.current.uploadFile(createFile("image.png", "image/png"))
      })

      expect(result.current.imageCount).toBe(1)

      act(() => {
        result.current.clear()
      })

      expect(result.current.imageCount).toBe(0)
      expect(result.current.pendingAttachments).toHaveLength(0)
    })
  })
})
