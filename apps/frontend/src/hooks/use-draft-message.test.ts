import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useDraftMessage, getDraftMessageKey } from "./use-draft-message"
import type { JSONContent } from "@threa/types"
import * as dbModule from "@/db"
import * as draftStoreModule from "@/stores/draft-store"

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }
const makeDoc = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : undefined }],
})
// Mock Dexie database
const mockGet = vi.fn()
const mockPut = vi.fn()
const mockDelete = vi.fn()
const mockUpsertDraftMessageInCache = vi.fn()
const mockDeleteDraftMessageFromCache = vi.fn()

let seededDraftCache = false
let draftMessages: Array<{
  id: string
  workspaceId: string
  contentJson: JSONContent
  attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }>
  updatedAt: number
}> = []

describe("getDraftMessageKey", () => {
  it("should return stream key format for stream type", () => {
    const key = getDraftMessageKey({ type: "stream", streamId: "stream_123" })
    expect(key).toBe("stream:stream_123")
  })

  it("should return thread key format for thread type", () => {
    const key = getDraftMessageKey({ type: "thread", parentMessageId: "msg_456" })
    expect(key).toBe("thread:msg_456")
  })
})

describe("useDraftMessage", () => {
  const workspaceId = "ws_123"
  const draftKey = "stream:stream_456"

  beforeEach(() => {
    vi.restoreAllMocks()
    mockGet.mockReset()
    mockPut.mockReset()
    mockDelete.mockReset()
    mockUpsertDraftMessageInCache.mockReset()
    mockDeleteDraftMessageFromCache.mockReset()
    vi.useFakeTimers()
    seededDraftCache = false
    draftMessages = []
    mockGet.mockResolvedValue(undefined)
    mockPut.mockResolvedValue(undefined)
    mockDelete.mockResolvedValue(undefined)

    vi.spyOn(dbModule.db.draftMessages, "get").mockImplementation(((...args: unknown[]) =>
      mockGet(...args)) as unknown as typeof dbModule.db.draftMessages.get)
    vi.spyOn(dbModule.db.draftMessages, "put").mockImplementation(((...args: unknown[]) =>
      mockPut(...args)) as unknown as typeof dbModule.db.draftMessages.put)
    vi.spyOn(dbModule.db.draftMessages, "delete").mockImplementation(((...args: unknown[]) =>
      mockDelete(...args)) as unknown as typeof dbModule.db.draftMessages.delete)

    vi.spyOn(draftStoreModule, "hasSeededDraftCache").mockImplementation(() => seededDraftCache)
    vi.spyOn(draftStoreModule, "useDraftMessagesFromStore").mockImplementation(
      () => draftMessages as ReturnType<typeof draftStoreModule.useDraftMessagesFromStore>
    )
    vi.spyOn(draftStoreModule, "upsertDraftMessageInCache").mockImplementation(((...args: unknown[]) =>
      mockUpsertDraftMessageInCache(...args)) as unknown as typeof draftStoreModule.upsertDraftMessageInCache)
    vi.spyOn(draftStoreModule, "deleteDraftMessageFromCache").mockImplementation(((...args: unknown[]) =>
      mockDeleteDraftMessageFromCache(...args)) as unknown as typeof draftStoreModule.deleteDraftMessageFromCache)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("isLoaded state", () => {
    it("should return isLoaded=false while Dexie is loading", () => {
      seededDraftCache = false

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))

      expect(result.current.isLoaded).toBe(false)
      expect(result.current.contentJson).toEqual(EMPTY_DOC)
      expect(result.current.attachments).toEqual([])
    })

    it("should return isLoaded=true after Dexie finishes loading with no data", () => {
      seededDraftCache = true

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))

      expect(result.current.isLoaded).toBe(true)
      expect(result.current.contentJson).toEqual(EMPTY_DOC)
      expect(result.current.attachments).toEqual([])
    })

    it("should return isLoaded=true with saved content after Dexie loads", () => {
      seededDraftCache = true
      const savedContentJson = makeDoc("Hello world")
      draftMessages = [
        {
          id: draftKey,
          workspaceId,
          contentJson: savedContentJson,
          attachments: [{ id: "attach_1", filename: "test.txt", mimeType: "text/plain", sizeBytes: 100 }],
          updatedAt: Date.now(),
        },
      ]

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))

      expect(result.current.isLoaded).toBe(true)
      expect(result.current.contentJson).toEqual(savedContentJson)
      expect(result.current.attachments).toHaveLength(1)
      expect(result.current.attachments[0].filename).toBe("test.txt")
    })

    it("should return empty state for a different draft key once the workspace cache is loaded", () => {
      seededDraftCache = true
      const oldDraftKey = "stream:stream_old"
      const newDraftKey = "stream:stream_new"

      draftMessages = [
        {
          id: oldDraftKey,
          workspaceId,
          contentJson: makeDoc("Old draft"),
          attachments: [{ id: "attach_old", filename: "old.txt", mimeType: "text/plain", sizeBytes: 100 }],
          updatedAt: Date.now(),
        },
      ]

      const { result, rerender } = renderHook(({ currentDraftKey }) => useDraftMessage(workspaceId, currentDraftKey), {
        initialProps: { currentDraftKey: oldDraftKey },
      })

      expect(result.current.isLoaded).toBe(true)
      expect(result.current.attachments).toHaveLength(1)

      rerender({ currentDraftKey: newDraftKey })

      expect(result.current.isLoaded).toBe(true)
      expect(result.current.contentJson).toEqual(EMPTY_DOC)
      expect(result.current.attachments).toEqual([])
    })
  })

  describe("saveDraft", () => {
    it("should save content to database", async () => {
      seededDraftCache = true

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))
      const newContent = makeDoc("New content")

      await act(async () => {
        await result.current.saveDraft(newContent)
      })

      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          id: draftKey,
          workspaceId,
          contentJson: newContent,
          attachments: [],
        })
      )
    })

    it("never persists a draft for an E2E stream and purges any on disk (E2EE-4)", async () => {
      seededDraftCache = true

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey, true))

      await act(async () => {
        await result.current.saveDraft(makeDoc("secret plaintext"))
        result.current.saveDraftDebounced(makeDoc("more secret plaintext"))
        await result.current.addAttachment({ id: "att_1", filename: "f", mimeType: "text/plain", sizeBytes: 1 })
      })

      // Nothing written to disk through any persistence entry point...
      expect(mockPut).not.toHaveBeenCalled()
      // ...and a pre-existing on-disk draft is cleared on mount.
      expect(mockDelete).toHaveBeenCalledWith(draftKey)
    })

    it("cancels a debounced plaintext save when the stream becomes encrypted mid-flight (E2EE-4 race)", async () => {
      seededDraftCache = true

      const { result, rerender } = renderHook(
        ({ e2e }: { e2e: boolean }) => useDraftMessage(workspaceId, draftKey, e2e),
        {
          initialProps: { e2e: false },
        }
      )

      // Queue a debounced save while the stream is still plaintext...
      act(() => {
        result.current.saveDraftDebounced(makeDoc("typed before the stream was encrypted"))
      })
      // ...then the stream becomes encrypted before the debounce window elapses.
      rerender({ e2e: true })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })

      // The in-flight save must NOT re-persist plaintext after the purge.
      expect(mockPut).not.toHaveBeenCalled()
      // The encrypt transition purged any on-disk draft.
      expect(mockDelete).toHaveBeenCalledWith(draftKey)
    })

    it("should delete draft when content is empty and no attachments", async () => {
      seededDraftCache = true
      mockGet.mockResolvedValue({ attachments: [] })

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))

      await act(async () => {
        await result.current.saveDraft(EMPTY_DOC)
      })

      expect(mockDelete).toHaveBeenCalledWith(draftKey)
      expect(mockPut).not.toHaveBeenCalled()
    })

    it("should preserve existing attachments when saving content", async () => {
      seededDraftCache = true
      const existingAttachments = [{ id: "attach_1", filename: "file.txt", mimeType: "text/plain", sizeBytes: 50 }]
      mockGet.mockResolvedValue({ attachments: existingAttachments })

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))
      const updatedContent = makeDoc("Updated content")

      await act(async () => {
        await result.current.saveDraft(updatedContent)
      })

      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          contentJson: updatedContent,
          attachments: existingAttachments,
        })
      )
    })

    it("should preserve existing contextRefs sidecar when saving content (regression: typing wiped the chip)", async () => {
      seededDraftCache = true
      const existingRefs = [
        {
          refKind: "thread",
          streamId: "stream_src",
          fromMessageId: null,
          toMessageId: null,
          status: "ready" as const,
          fingerprint: null,
          errorMessage: null,
        },
      ]
      mockGet.mockResolvedValue({ attachments: [], contextRefs: existingRefs })

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))
      const updatedContent = makeDoc("user is typing")

      await act(async () => {
        await result.current.saveDraft(updatedContent)
      })

      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          contentJson: updatedContent,
          attachments: [],
          contextRefs: existingRefs,
        })
      )
    })

    it("should keep the draft alive when content goes empty but contextRefs is non-empty", async () => {
      seededDraftCache = true
      const existingRefs = [
        {
          refKind: "thread",
          streamId: "stream_src",
          fromMessageId: null,
          toMessageId: null,
          status: "ready" as const,
          fingerprint: null,
          errorMessage: null,
        },
      ]
      mockGet.mockResolvedValue({ attachments: [], contextRefs: existingRefs })

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))

      await act(async () => {
        await result.current.saveDraft(EMPTY_DOC)
      })

      expect(mockDelete).not.toHaveBeenCalled()
      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          contentJson: EMPTY_DOC,
          contextRefs: existingRefs,
        })
      )
    })
  })

  describe("saveDraftDebounced", () => {
    it("should debounce saves", async () => {
      seededDraftCache = true

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))
      const thirdContent = makeDoc("Third")

      act(() => {
        result.current.saveDraftDebounced(makeDoc("First"))
        result.current.saveDraftDebounced(makeDoc("Second"))
        result.current.saveDraftDebounced(thirdContent)
      })

      // Nothing saved yet
      expect(mockPut).not.toHaveBeenCalled()

      // Advance past debounce delay
      await act(async () => {
        vi.advanceTimersByTime(600)
      })

      // Only the last value should be saved
      expect(mockPut).toHaveBeenCalledTimes(1)
      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          contentJson: thirdContent,
        })
      )
    })
  })

  describe("addAttachment", () => {
    it("should add attachment to empty draft", async () => {
      seededDraftCache = true
      mockGet.mockResolvedValue(undefined)

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))

      const attachment = { id: "attach_1", filename: "new.txt", mimeType: "text/plain", sizeBytes: 100 }

      await act(async () => {
        await result.current.addAttachment(attachment)
      })

      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          id: draftKey,
          workspaceId,
          contentJson: EMPTY_DOC,
          attachments: [attachment],
        })
      )
    })

    it("should not add duplicate attachment", async () => {
      seededDraftCache = true
      const existingAttachment = { id: "attach_1", filename: "existing.txt", mimeType: "text/plain", sizeBytes: 50 }
      mockGet.mockResolvedValue({ contentJson: EMPTY_DOC, attachments: [existingAttachment] })

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))

      await act(async () => {
        await result.current.addAttachment(existingAttachment)
      })

      expect(mockPut).not.toHaveBeenCalled()
    })
  })

  describe("removeAttachment", () => {
    it("should remove attachment from draft", async () => {
      seededDraftCache = true
      const attachments = [
        { id: "attach_1", filename: "file1.txt", mimeType: "text/plain", sizeBytes: 50 },
        { id: "attach_2", filename: "file2.txt", mimeType: "text/plain", sizeBytes: 100 },
      ]
      mockGet.mockResolvedValue({ id: draftKey, contentJson: makeDoc("Some content"), attachments })

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))

      await act(async () => {
        await result.current.removeAttachment("attach_1")
      })

      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: [{ id: "attach_2", filename: "file2.txt", mimeType: "text/plain", sizeBytes: 100 }],
        })
      )
    })

    it("should delete draft when removing last attachment and content is empty", async () => {
      seededDraftCache = true
      const attachment = { id: "attach_1", filename: "file.txt", mimeType: "text/plain", sizeBytes: 50 }
      mockGet.mockResolvedValue({ id: draftKey, contentJson: EMPTY_DOC, attachments: [attachment] })

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))

      await act(async () => {
        await result.current.removeAttachment("attach_1")
      })

      expect(mockDelete).toHaveBeenCalledWith(draftKey)
      expect(mockPut).not.toHaveBeenCalled()
    })
  })

  describe("clearDraft", () => {
    it("should delete the draft", async () => {
      seededDraftCache = true

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))

      await act(async () => {
        await result.current.clearDraft()
      })

      expect(mockDelete).toHaveBeenCalledWith(draftKey)
    })

    it("should cancel pending debounced save", async () => {
      seededDraftCache = true

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))

      act(() => {
        result.current.saveDraftDebounced(makeDoc("Will be cancelled"))
      })

      await act(async () => {
        await result.current.clearDraft()
      })

      // Advance past debounce
      await act(async () => {
        vi.advanceTimersByTime(600)
      })

      // Only delete should have been called, not put
      expect(mockDelete).toHaveBeenCalledWith(draftKey)
      expect(mockPut).not.toHaveBeenCalled()
    })
  })
})
