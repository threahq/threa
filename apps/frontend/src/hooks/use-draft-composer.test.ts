import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useDraftComposer } from "./use-draft-composer"
import type { JSONContent } from "@threahq/types"
import * as useDraftMessageModule from "./use-draft-message"
import * as useAttachmentsModule from "./use-attachments"
import { markDraftMigrated, resetDraftResolutionGuard } from "@/sync/draft-resolution-guard"

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }
const makeDoc = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : undefined }],
})

// Mock useDraftMessage
const mockSaveDraft = vi.fn()
const mockSaveDraftDebounced = vi.fn()
const mockAddDraftAttachment = vi.fn()
const mockRemoveDraftAttachment = vi.fn()
const mockClearDraft = vi.fn()
const mockResolveDraft = vi.fn()
const mockCancelPendingSave = vi.fn()

/** What `saveDraft` resolves to when it actually persisted (see its contract). */
const persistedRow = (id: string) => ({ id }) as unknown as import("@/db").CachedDraft

interface MockDraftState {
  isLoaded: boolean
  contentJson: JSONContent
  attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }>
  contextRefs?: Array<{
    refKind: string
    streamId: string
    fromMessageId: string | null
    toMessageId: string | null
    status: "pending" | "ready" | "inline" | "error"
    fingerprint: string | null
    errorMessage: string | null
  }>
}

let mockDraftIsLoaded = true
let mockDraftContentJson: JSONContent = EMPTY_DOC
let mockDraftAttachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }> = []
let mockDraftLoadedId: string | null = "draft_mock"
let mockDraftStateByKey: Record<string, MockDraftState> = {}

// Mock useAttachments
let mockPendingAttachments: Array<{
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  status: "uploading" | "uploaded" | "error"
  error?: string
}> = []

const mockFileInputRef = { current: null }
const mockHandleFileSelect = vi.fn()
const mockRemoveAttachment = vi.fn()
const mockCancelUpload = vi.fn()
const mockClearAttachments = vi.fn()
const mockRestoreAttachments = vi.fn()

describe("useDraftComposer", () => {
  const workspaceId = "ws_123"
  const draftKey = "stream:stream_456"
  const scopeId = "stream_456"

  beforeEach(() => {
    vi.restoreAllMocks()
    resetDraftResolutionGuard()
    mockSaveDraft.mockReset()
    mockSaveDraftDebounced.mockReset()
    mockAddDraftAttachment.mockReset()
    mockRemoveDraftAttachment.mockReset()
    mockClearDraft.mockReset()
    mockResolveDraft.mockReset()
    mockCancelPendingSave.mockReset()
    mockHandleFileSelect.mockReset()
    mockRemoveAttachment.mockReset()
    mockClearAttachments.mockReset()
    mockRestoreAttachments.mockReset()

    mockDraftIsLoaded = true
    mockDraftContentJson = EMPTY_DOC
    mockDraftAttachments = []
    mockDraftLoadedId = "draft_mock"
    mockDraftStateByKey = {}
    mockPendingAttachments = []

    vi.spyOn(useDraftMessageModule, "useDraftMessage").mockImplementation(
      (_workspaceId: string, currentDraftKey: string) => {
        const state = mockDraftStateByKey[currentDraftKey] ?? {
          isLoaded: mockDraftIsLoaded,
          contentJson: mockDraftContentJson,
          attachments: mockDraftAttachments,
        }

        return {
          isLoaded: state.isLoaded,
          contentJson: state.contentJson,
          attachments: state.attachments,
          contextRefs: state.contextRefs ?? [],
          loadedDraftId: mockDraftLoadedId,
          saveDraft: mockSaveDraft,
          saveDraftDebounced: mockSaveDraftDebounced,
          cancelPendingSave: mockCancelPendingSave,
          addAttachment: mockAddDraftAttachment,
          removeAttachment: mockRemoveDraftAttachment,
          clearDraft: mockClearDraft,
          resolveDraft: mockResolveDraft,
        } as unknown as ReturnType<typeof useDraftMessageModule.useDraftMessage>
      }
    )

    vi.spyOn(useAttachmentsModule, "useAttachments").mockImplementation(
      () =>
        ({
          pendingAttachments: mockPendingAttachments,
          getPendingAttachmentsSnapshot: () => mockPendingAttachments,
          fileInputRef: mockFileInputRef,
          handleFileSelect: mockHandleFileSelect,
          removeAttachment: mockRemoveAttachment,
          cancelUpload: mockCancelUpload,
          uploadedIds: mockPendingAttachments
            .filter((a) => a.status !== "error" && !a.id.startsWith("temp_"))
            .map((a) => a.id),
          isUploading: mockPendingAttachments.some((a) => a.status === "uploading"),
          // Mirrors the real hook: a temp-id chip is a reservation in flight.
          isReserving: mockPendingAttachments.some((a) => a.status === "uploading" && a.id.startsWith("temp_")),
          hasFailed: mockPendingAttachments.some((a) => a.status === "error"),
          clear: mockClearAttachments,
          restore: mockRestoreAttachments,
        }) as unknown as ReturnType<typeof useAttachmentsModule.useAttachments>
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("initialization", () => {
    it("should return isLoaded=false while draft is loading", () => {
      mockDraftIsLoaded = false

      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      expect(result.current.isLoaded).toBe(false)
      expect(result.current.content).toEqual(EMPTY_DOC)
    })

    it("should return isLoaded=true after draft finishes loading", () => {
      mockDraftIsLoaded = true

      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      expect(result.current.isLoaded).toBe(true)
    })

    it("should restore saved content on initialization", () => {
      mockDraftIsLoaded = true
      const savedContent = makeDoc("Saved content")
      mockDraftContentJson = savedContent

      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      expect(result.current.content).toEqual(savedContent)
    })

    it("should restore saved attachments on initialization", () => {
      mockDraftIsLoaded = true
      mockDraftAttachments = [{ id: "attach_1", filename: "test.txt", mimeType: "text/plain", sizeBytes: 100 }]

      renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      expect(mockRestoreAttachments).toHaveBeenCalledWith(mockDraftAttachments)
    })

    it("should not restore while still loading", () => {
      mockDraftIsLoaded = false
      mockDraftContentJson = makeDoc("Should not appear")
      mockDraftAttachments = [{ id: "attach_1", filename: "test.txt", mimeType: "text/plain", sizeBytes: 100 }]

      renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      expect(mockRestoreAttachments).not.toHaveBeenCalled()
    })

    it("should use initialContent when provided", () => {
      mockDraftIsLoaded = true
      mockDraftContentJson = EMPTY_DOC // No saved draft
      const initialContent = makeDoc("Initial text")

      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId, initialContent }))

      expect(result.current.content).toEqual(initialContent)
    })
  })

  describe("scope change", () => {
    it("keeps live content when the persistence key changes within one logical scope", () => {
      mockDraftLoadedId = null
      const { result, rerender } = renderHook(
        ({ currentKey }) => useDraftComposer({ workspaceId, draftKey: currentKey, scopeId: "promotion:draft_1" }),
        { initialProps: { currentKey: "stream:draft_1" } }
      )

      act(() => result.current.handleContentChange(makeDoc("follow-up typed during promotion")))
      rerender({ currentKey: "stream:stream_1" })

      expect(result.current.content).toEqual(makeDoc("follow-up typed during promotion"))
      expect(mockClearAttachments).not.toHaveBeenCalled()
    })

    it("keeps live content and attachments when the same draft identity changes filing scope", () => {
      const sourceKey = "board:reply:conv_1"
      const targetKey = "stream:stream_1"
      mockDraftLoadedId = "draft_stable"
      mockDraftStateByKey[sourceKey] = { isLoaded: true, contentJson: makeDoc("saved"), attachments: [] }
      mockDraftStateByKey[targetKey] = { isLoaded: true, contentJson: makeDoc("saved"), attachments: [] }

      const { result, rerender } = renderHook(
        ({ currentKey }) => useDraftComposer({ workspaceId, draftKey: currentKey, scopeId: currentKey }),
        { initialProps: { currentKey: sourceKey } }
      )
      act(() => result.current.handleContentChange(makeDoc("typed here")))
      mockClearAttachments.mockClear()

      rerender({ currentKey: targetKey })

      expect(result.current.content).toEqual(makeDoc("typed here"))
      expect(mockClearAttachments).not.toHaveBeenCalled()
    })

    it("should reset content when scopeId changes", () => {
      const { result, rerender } = renderHook(({ scopeId }) => useDraftComposer({ workspaceId, draftKey, scopeId }), {
        initialProps: { scopeId: "stream_1" },
      })

      // Set content
      const newContent = makeDoc("Some content")
      act(() => {
        result.current.setContent(newContent)
      })
      expect(result.current.content).toEqual(newContent)

      // Change to a scope that points at another identity.
      mockDraftLoadedId = null
      rerender({ scopeId: "stream_2" })

      expect(result.current.content).toEqual(EMPTY_DOC)
    })

    it("should clear attachments when scopeId changes", () => {
      const { rerender } = renderHook(({ scopeId }) => useDraftComposer({ workspaceId, draftKey, scopeId }), {
        initialProps: { scopeId: "stream_1" },
      })

      // Change to a scope that points at another identity.
      mockDraftLoadedId = null
      rerender({ scopeId: "stream_2" })

      expect(mockClearAttachments).toHaveBeenCalled()
    })

    it("should not persist stale uploaded attachments after a scope change until attachments clear", () => {
      mockPendingAttachments = [
        { id: "attach_1", filename: "test.txt", mimeType: "text/plain", sizeBytes: 100, status: "uploaded" },
      ]

      const { rerender } = renderHook(({ scopeId }) => useDraftComposer({ workspaceId, draftKey, scopeId }), {
        initialProps: { scopeId: "stream_1" },
      })

      mockAddDraftAttachment.mockClear()

      rerender({ scopeId: "stream_2" })
      rerender({ scopeId: "stream_2" })

      expect(mockAddDraftAttachment).not.toHaveBeenCalled()

      mockPendingAttachments = []
      rerender({ scopeId: "stream_2" })

      expect(mockAddDraftAttachment).not.toHaveBeenCalled()

      mockPendingAttachments = [
        { id: "attach_2", filename: "fresh.txt", mimeType: "text/plain", sizeBytes: 200, status: "uploaded" },
      ]
      rerender({ scopeId: "stream_2" })

      expect(mockAddDraftAttachment).toHaveBeenCalledWith({
        id: "attach_2",
        filename: "fresh.txt",
        mimeType: "text/plain",
        sizeBytes: 200,
      })
    })

    it("should resume persistence after restoring saved attachments in the destination draft", () => {
      const restoredAttachment = {
        id: "attach_saved",
        filename: "saved.txt",
        mimeType: "text/plain",
        sizeBytes: 150,
      }

      mockDraftStateByKey["stream:stream_2"] = {
        isLoaded: true,
        contentJson: EMPTY_DOC,
        attachments: [restoredAttachment],
      }

      const { rerender } = renderHook(
        ({ currentDraftKey, currentScopeId }) =>
          useDraftComposer({ workspaceId, draftKey: currentDraftKey, scopeId: currentScopeId }),
        {
          initialProps: { currentDraftKey: "stream:stream_1", currentScopeId: "stream_1" },
        }
      )

      rerender({ currentDraftKey: "stream:stream_2", currentScopeId: "stream_2" })

      expect(mockRestoreAttachments).toHaveBeenCalledWith([restoredAttachment])

      mockAddDraftAttachment.mockClear()
      mockPendingAttachments = [{ ...restoredAttachment, status: "uploaded" as const }]
      rerender({ currentDraftKey: "stream:stream_2", currentScopeId: "stream_2" })

      expect(mockAddDraftAttachment).not.toHaveBeenCalled()

      const freshAttachment = {
        id: "attach_fresh",
        filename: "fresh.txt",
        mimeType: "text/plain",
        sizeBytes: 200,
      }
      mockPendingAttachments = [
        { ...restoredAttachment, status: "uploaded" as const },
        { ...freshAttachment, status: "uploaded" as const },
      ]
      rerender({ currentDraftKey: "stream:stream_2", currentScopeId: "stream_2" })

      expect(mockAddDraftAttachment).toHaveBeenCalledWith(freshAttachment)
    })

    it("should not persist previous scope attachments while the destination draft is restoring", () => {
      const previousAttachment = {
        id: "attach_previous",
        filename: "previous.txt",
        mimeType: "text/plain",
        sizeBytes: 125,
      }
      const restoredAttachment = {
        id: "attach_saved",
        filename: "saved.txt",
        mimeType: "text/plain",
        sizeBytes: 150,
      }

      mockPendingAttachments = [{ ...previousAttachment, status: "uploaded" as const }]
      mockDraftStateByKey["stream:stream_2"] = {
        isLoaded: true,
        contentJson: EMPTY_DOC,
        attachments: [restoredAttachment],
      }

      const { rerender } = renderHook(
        ({ currentDraftKey, currentScopeId }) =>
          useDraftComposer({ workspaceId, draftKey: currentDraftKey, scopeId: currentScopeId }),
        {
          initialProps: { currentDraftKey: "stream:stream_1", currentScopeId: "stream_1" },
        }
      )

      mockAddDraftAttachment.mockClear()

      rerender({ currentDraftKey: "stream:stream_2", currentScopeId: "stream_2" })

      expect(mockAddDraftAttachment).not.toHaveBeenCalled()
      expect(mockRestoreAttachments).toHaveBeenCalledWith([restoredAttachment])

      mockPendingAttachments = [{ ...restoredAttachment, status: "uploaded" as const }]
      rerender({ currentDraftKey: "stream:stream_2", currentScopeId: "stream_2" })

      expect(mockAddDraftAttachment).not.toHaveBeenCalled()
    })
  })

  describe("handleContentChange", () => {
    it("should update content immediately", () => {
      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))
      const newContent = makeDoc("New content")

      act(() => {
        result.current.handleContentChange(newContent)
      })

      expect(result.current.content).toEqual(newContent)
    })

    it("should call saveDraftDebounced", () => {
      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))
      const newContent = makeDoc("New content")

      act(() => {
        result.current.handleContentChange(newContent)
      })

      expect(mockSaveDraftDebounced).toHaveBeenCalledWith(newContent)
    })
  })

  describe("handleRemoveAttachment", () => {
    it("should remove from both UI and draft storage", () => {
      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      act(() => {
        result.current.handleRemoveAttachment("attach_123")
      })

      expect(mockRemoveAttachment).toHaveBeenCalledWith("attach_123")
      expect(mockRemoveDraftAttachment).toHaveBeenCalledWith("attach_123")
    })
  })

  describe("canSend", () => {
    it("should be true with content", () => {
      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      act(() => {
        result.current.setContent(makeDoc("Hello"))
      })

      expect(result.current.canSend).toBe(true)
    })

    it("should be true with uploaded attachments only", () => {
      mockPendingAttachments = [
        { id: "attach_1", filename: "test.txt", mimeType: "text/plain", sizeBytes: 100, status: "uploaded" },
      ]

      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      expect(result.current.canSend).toBe(true)
    })

    it("should be false when sending", () => {
      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      act(() => {
        result.current.setContent(makeDoc("Hello"))
        result.current.setIsSending(true)
      })

      expect(result.current.canSend).toBe(false)
    })

    it("should be false only while a reservation is in flight (temp id, no server id yet)", () => {
      mockPendingAttachments = [
        { id: "temp_1", filename: "test.txt", mimeType: "text/plain", sizeBytes: 100, status: "uploading" },
      ]

      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      act(() => {
        result.current.setContent(makeDoc("Hello"))
      })

      // No id yet — sending now would silently drop the file.
      expect(result.current.canSend).toBe(false)
    })

    it("should stay sendable while a reserved upload's bytes are still streaming (send-while-uploading)", () => {
      mockPendingAttachments = [
        { id: "attach_1", filename: "test.txt", mimeType: "text/plain", sizeBytes: 100, status: "uploading" },
      ]

      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      act(() => {
        result.current.setContent(makeDoc("Hello"))
      })

      // The id is real: the message binds it and the bytes finish in the background.
      expect(result.current.canSend).toBe(true)
    })

    it("should be true when uploads have failed (send with whatever succeeded)", () => {
      mockPendingAttachments = [
        { id: "temp_1", filename: "test.txt", mimeType: "text/plain", sizeBytes: 100, status: "error" },
      ]

      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      act(() => {
        result.current.setContent(makeDoc("Hello"))
      })

      expect(result.current.canSend).toBe(true)
    })

    it("should be false with empty content and no attachments", () => {
      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      expect(result.current.canSend).toBe(false)
    })

    it("should be false with whitespace-only content", () => {
      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      // Empty paragraph is considered empty
      act(() => {
        result.current.setContent(EMPTY_DOC)
      })

      expect(result.current.canSend).toBe(false)
    })

    it("should be false when a context-ref sidecar entry is still pending precompute", () => {
      mockDraftStateByKey[`stream:${scopeId}`] = {
        isLoaded: true,
        contentJson: makeDoc("Hello"),
        attachments: [],
        contextRefs: [
          {
            refKind: "thread",
            streamId: "stream_src",
            fromMessageId: null,
            toMessageId: null,
            status: "pending",
            fingerprint: null,
            errorMessage: null,
          },
        ],
      }

      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))
      expect(result.current.canSend).toBe(false)
    })

    it("should be false when a context-ref sidecar entry errored during precompute", () => {
      mockDraftStateByKey[`stream:${scopeId}`] = {
        isLoaded: true,
        contentJson: makeDoc("Hello"),
        attachments: [],
        contextRefs: [
          {
            refKind: "thread",
            streamId: "stream_src",
            fromMessageId: null,
            toMessageId: null,
            status: "error",
            fingerprint: null,
            errorMessage: "403 forbidden",
          },
        ],
      }

      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))
      expect(result.current.canSend).toBe(false)
    })

    it("should be true when every context-ref sidecar entry is ready or inline", () => {
      mockDraftStateByKey[`stream:${scopeId}`] = {
        isLoaded: true,
        contentJson: makeDoc("Hello"),
        attachments: [],
        contextRefs: [
          {
            refKind: "thread",
            streamId: "stream_src",
            fromMessageId: null,
            toMessageId: null,
            status: "ready",
            fingerprint: "fp_1",
            errorMessage: null,
          },
        ],
      }

      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))
      expect(result.current.canSend).toBe(true)
    })

    it("should be true with only a ready context-ref (no body text, no attachments)", () => {
      // Regression: clicking "Discuss with Ariadne" attaches a thread chip
      // but doesn't fill the composer body. The send button shouldn't force
      // the user to type a placeholder message — the chip itself is a
      // sufficient payload to dispatch the discussion turn.
      mockDraftStateByKey[`stream:${scopeId}`] = {
        isLoaded: true,
        contentJson: EMPTY_DOC,
        attachments: [],
        contextRefs: [
          {
            refKind: "thread",
            streamId: "stream_src",
            fromMessageId: null,
            toMessageId: null,
            status: "ready",
            fingerprint: "fp_1",
            errorMessage: null,
          },
        ],
      }

      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))
      expect(result.current.canSend).toBe(true)
    })
  })

  describe("isSending state", () => {
    it("should update when setIsSending is called", () => {
      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      expect(result.current.isSending).toBe(false)

      act(() => {
        result.current.setIsSending(true)
      })

      expect(result.current.isSending).toBe(true)

      act(() => {
        result.current.setIsSending(false)
      })

      expect(result.current.isSending).toBe(false)
    })
  })

  describe("clear helpers", () => {
    it("should expose clearDraft from useDraftMessage", () => {
      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      act(() => {
        result.current.clearDraft()
      })

      expect(mockClearDraft).toHaveBeenCalled()
    })

    it("should expose resolveDraft from useDraftMessage", () => {
      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      act(() => {
        result.current.resolveDraft()
      })

      expect(mockResolveDraft).toHaveBeenCalled()
    })

    it("should expose clearAttachments from useAttachments", () => {
      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      act(() => {
        result.current.clearAttachments()
      })

      expect(mockClearAttachments).toHaveBeenCalled()
    })
  })

  describe("attachment passthrough", () => {
    it("should expose pendingAttachments", () => {
      mockPendingAttachments = [
        { id: "attach_1", filename: "test.txt", mimeType: "text/plain", sizeBytes: 100, status: "uploaded" },
      ]

      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      expect(result.current.pendingAttachments).toEqual(mockPendingAttachments)
    })

    it("should expose uploadedIds", () => {
      mockPendingAttachments = [
        { id: "attach_1", filename: "test.txt", mimeType: "text/plain", sizeBytes: 100, status: "uploaded" },
        { id: "temp_2", filename: "uploading.txt", mimeType: "text/plain", sizeBytes: 100, status: "uploading" },
      ]

      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      expect(result.current.uploadedIds).toEqual(["attach_1"])
    })

    it("should expose isUploading", () => {
      mockPendingAttachments = [
        { id: "temp_1", filename: "test.txt", mimeType: "text/plain", sizeBytes: 100, status: "uploading" },
      ]

      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      expect(result.current.isUploading).toBe(true)
    })

    it("should expose hasFailed", () => {
      mockPendingAttachments = [
        { id: "temp_1", filename: "test.txt", mimeType: "text/plain", sizeBytes: 100, status: "error" },
      ]

      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      expect(result.current.hasFailed).toBe(true)
    })

    it("should expose fileInputRef", () => {
      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      expect(result.current.fileInputRef).toBe(mockFileInputRef)
    })

    it("should expose handleFileSelect", () => {
      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      expect(result.current.handleFileSelect).toBe(mockHandleFileSelect)
    })
  })

  describe("flushDraft (safe flush — never deletes)", () => {
    it("persists the live editor content when it is non-empty", async () => {
      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      act(() => {
        result.current.setContent(makeDoc("unsaved keystrokes"))
      })
      await act(async () => {
        await result.current.flushDraft()
      })

      expect(mockSaveDraft).toHaveBeenCalledWith(makeDoc("unsaved keystrokes"))
    })

    it("persists an existing empty row when a filing-only move requests it", async () => {
      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      await act(async () => {
        await result.current.flushDraft({ keepEmpty: true })
      })

      expect(mockSaveDraft).toHaveBeenCalledWith(EMPTY_DOC, [], undefined, { keepEmpty: true })
    })

    it("no-ops on an empty editor so a restore mid-hydration can't delete the loaded draft", async () => {
      // Regression: stash/restore used to flush `composer.content` unconditionally;
      // when the editor was still mid-hydration (transiently empty), the save took
      // the empty→delete path and destroyed the loaded draft.
      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      await act(async () => {
        await result.current.flushDraft()
      })

      expect(mockSaveDraft).not.toHaveBeenCalled()
    })
  })

  describe("markNeedsRehydrate (stash-restore re-hydration)", () => {
    it("applies the newly-loaded draft body in place after a rehydrate", () => {
      mockDraftIsLoaded = true
      mockDraftContentJson = makeDoc("first")
      const { result, rerender } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))
      expect(result.current.content).toEqual(makeDoc("first"))

      // A restore swaps the loaded pointer to a different draft, then re-hydrates.
      mockDraftContentJson = makeDoc("restored")
      act(() => {
        result.current.markNeedsRehydrate()
      })
      rerender()

      expect(result.current.content).toEqual(makeDoc("restored"))
    })

    it("does not re-fill the editor after the user clears it (no clobber)", () => {
      mockDraftIsLoaded = true
      mockDraftContentJson = makeDoc("saved body")
      const { result, rerender } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))
      expect(result.current.content).toEqual(makeDoc("saved body"))

      // User clears the editor — `savedDraft` still lags at "saved body" for a tick.
      act(() => {
        result.current.handleContentChange(EMPTY_DOC)
      })
      rerender()

      // Stays cleared: the late-hydrate yields to user engagement.
      expect(result.current.content).toEqual(EMPTY_DOC)
    })

    it("does not re-fill after a send-style clear while the loaded row lags (restored-then-sent)", () => {
      // Regression: a restored draft sent without further typing left `userEngaged`
      // false; the editor cleared on send but the late-hydrate re-filled it from the
      // still-present `savedDraft` before the resolve removed the row.
      mockDraftIsLoaded = true
      mockDraftContentJson = makeDoc("restored body")
      const { result, rerender } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))
      expect(result.current.content).toEqual(makeDoc("restored body")) // hydrated; user did NOT type

      // Send clears the editor; the loaded row still lags (savedDraft unchanged for a tick).
      act(() => {
        result.current.setContent(EMPTY_DOC)
      })
      rerender()

      // Stays cleared — no rising edge of body-availability, so no re-fill.
      expect(result.current.content).toEqual(EMPTY_DOC)
    })

    it("blanks the editor when the loaded draft is removed underneath it (resolved on another device)", () => {
      // Start typing on one device, finish + send on another: the partial draft
      // must not linger here once its pointer is cleared (loaded id → null).
      mockDraftIsLoaded = true
      mockDraftContentJson = makeDoc("roamed body")
      mockDraftLoadedId = "draft_roamed"
      const { result, rerender } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))
      expect(result.current.content).toEqual(makeDoc("roamed body"))

      // The draft is sent/resolved elsewhere: its `draft:deleted` clears the pointer.
      mockDraftLoadedId = null
      mockDraftContentJson = EMPTY_DOC
      rerender()

      expect(result.current.content).toEqual(EMPTY_DOC)
    })

    it("hydrates an attachment-only sealed draft's chips when they decrypt after unlock (Stage 4d)", () => {
      // Locked at mount: an E2E draft with files but an empty body resolves no body
      // and no attachments. On unlock its attachments decrypt and must late-hydrate
      // even though there is no body to fill into the editor.
      mockDraftIsLoaded = true
      mockDraftContentJson = EMPTY_DOC
      mockDraftAttachments = []
      const { rerender } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))
      expect(mockRestoreAttachments).not.toHaveBeenCalled()

      // Unlock + decrypt: the attachment metadata becomes available (still no body).
      const attachment = { id: "att_1", filename: "secret.pdf", mimeType: "application/pdf", sizeBytes: 1234 }
      mockDraftAttachments = [attachment]
      rerender()

      expect(mockRestoreAttachments).toHaveBeenCalledWith([attachment])
    })

    it("does not clobber typed content when a deferred (decrypting) draft body lands after the user types", () => {
      // Repro of the staging data-loss bug: restore an E2E draft whose sealed body
      // is still decrypting. `isDraftLoaded` stays false, so the one-shot init is
      // DEFERRED. The user types into the blanked editor; when the decrypt lands,
      // `isDraftLoaded` flips true and the deferred init runs for the FIRST time.
      // It must yield to the keystrokes the user already made — a focused composer
      // is never overwritten by anything but the user's own typing.
      mockDraftIsLoaded = true
      mockDraftContentJson = makeDoc("original body")
      const { result, rerender } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))
      expect(result.current.content).toEqual(makeDoc("original body"))

      // Restore a different draft, then simulate its sealed body still decrypting.
      act(() => {
        result.current.markNeedsRehydrate()
      })
      mockDraftIsLoaded = false
      mockDraftContentJson = EMPTY_DOC
      rerender()

      // User types into the blank editor before the restored body is readable.
      act(() => {
        result.current.handleContentChange(makeDoc("typed during decrypt"))
      })
      expect(result.current.content).toEqual(makeDoc("typed during decrypt"))

      // Decrypt lands: the loaded body becomes available and isLoaded flips true.
      mockDraftIsLoaded = true
      mockDraftContentJson = makeDoc("decrypted loaded body")
      rerender()

      expect(result.current.content).toEqual(makeDoc("typed during decrypt"))
    })

    it("preserves in-progress edits when the loaded pointer briefly flickers to null", () => {
      // Repro of the mobile revert seen on staging: while the user edits (live
      // content ahead of the debounced save), `loadedDraftId` momentarily reads
      // null — a transient re-read of the loaded pointer. The clear-on-removal
      // effect used to blank the editor and reset the engagement guard; on the
      // pointer's return, the late-hydrate rising edge then re-filled the stale
      // last-saved body, dropping the un-saved keystrokes. A real removal migrates
      // unpushed edits to a NEW id rather than nulling, so a null-while-engaged is
      // a flicker and must never wipe the editor.
      mockDraftIsLoaded = true
      mockDraftContentJson = makeDoc("saved body")
      mockDraftLoadedId = "draft_x"
      const { result, rerender } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))
      expect(result.current.content).toEqual(makeDoc("saved body"))

      // User types ahead of the debounce (savedDraft still lags at "saved body").
      act(() => {
        result.current.handleContentChange(makeDoc("saved body and more"))
      })
      expect(result.current.content).toEqual(makeDoc("saved body and more"))

      // Pointer flickers to null (no loaded row → savedDraft reads empty) …
      mockDraftLoadedId = null
      mockDraftContentJson = EMPTY_DOC
      rerender()
      // … then returns, with savedDraft still the stale last-saved body.
      mockDraftLoadedId = "draft_x"
      mockDraftContentJson = makeDoc("saved body")
      rerender()

      expect(result.current.content).toEqual(makeDoc("saved body and more"))
    })
  })

  describe("repoint (loaded pointer changes value)", () => {
    it("rehydrates an idle composer from the newly-pointed draft", () => {
      mockDraftIsLoaded = true
      mockDraftLoadedId = "draft_x"
      mockDraftContentJson = makeDoc("X body")
      const { result, rerender } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))
      expect(result.current.content).toEqual(makeDoc("X body"))

      act(() => {
        mockDraftLoadedId = "draft_y"
        mockDraftContentJson = makeDoc("Y body")
        rerender()
      })

      expect(result.current.content).toEqual(makeDoc("Y body"))
      // An idle editor holds only the hydrated body, so nothing needs flushing.
      expect(mockSaveDraft).not.toHaveBeenCalled()
    })

    it("flushes typed content to its OWN row before rehydrating from the new one", async () => {
      mockDraftIsLoaded = true
      mockDraftLoadedId = "draft_x"
      mockDraftContentJson = makeDoc("X body")
      // The flush must report a PERSISTED row: the reset is gated on it, so a
      // gated save (null) deliberately leaves the editor untouched instead.
      mockSaveDraft.mockResolvedValue({ id: "draft_x" })
      const { result, rerender } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      act(() => {
        result.current.handleContentChange(makeDoc("X body and typing"))
      })

      // The rehydrate happens once the flush RESOLVES (persist-gated), so the
      // pointer change and the settled flush need an async act.
      await act(async () => {
        mockDraftLoadedId = "draft_y"
        mockDraftContentJson = makeDoc("Y body")
        rerender()
      })

      // Identity-addressed: the typed body is written to draft_x, never to draft_y.
      expect(mockSaveDraft).toHaveBeenCalledWith(makeDoc("X body and typing"), [], "draft_x")
      expect(result.current.content).toEqual(makeDoc("Y body"))
    })

    it("keeps the typed content on screen when the repoint flush cannot persist", async () => {
      mockDraftIsLoaded = true
      mockDraftLoadedId = "draft_x"
      mockDraftContentJson = makeDoc("X body")
      // A gated save (locked E2E): the content reached no disk, so blanking the
      // editor would destroy it — the composer must keep it and its identity.
      mockSaveDraft.mockResolvedValue(null)
      const { result, rerender } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      act(() => {
        result.current.handleContentChange(makeDoc("X body and typing"))
      })

      await act(async () => {
        mockDraftLoadedId = "draft_y"
        mockDraftContentJson = makeDoc("Y body")
        rerender()
      })

      expect(mockSaveDraft).toHaveBeenCalledWith(makeDoc("X body and typing"), [], "draft_x")
      expect(result.current.content).toEqual(makeDoc("X body and typing"))
    })

    it("serializes overlapping repoints — a second pointer change waits for the in-flight flush", async () => {
      mockDraftIsLoaded = true
      mockDraftLoadedId = "draft_x"
      mockDraftContentJson = makeDoc("X body")
      // A flush the test controls: X→Y arrives while typed content is engaged,
      // and Y→Z lands BEFORE the X-flush resolves. The Z transition must queue
      // behind it — running it immediately would read half-updated refs and
      // flush the fragment into Y's real row.
      let resolveFlush!: (row: { id: string }) => void
      mockSaveDraft.mockImplementationOnce(() => new Promise<{ id: string }>((resolve) => (resolveFlush = resolve)))
      const { result, rerender } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      act(() => {
        result.current.handleContentChange(makeDoc("X body and typing"))
      })
      act(() => {
        mockDraftLoadedId = "draft_y"
        mockDraftContentJson = makeDoc("Y body")
        rerender()
      })
      // The X-flush is in flight; a second repoint lands.
      act(() => {
        mockDraftLoadedId = "draft_z"
        mockDraftContentJson = makeDoc("Z body")
        rerender()
      })

      // Only the X flush has run — the Z transition is queued, so no save was
      // fired against Y (that would be the fragment landing in Y's row).
      expect(mockSaveDraft).toHaveBeenCalledTimes(1)
      expect(mockSaveDraft).toHaveBeenCalledWith(makeDoc("X body and typing"), [], "draft_x")

      await act(async () => {
        resolveFlush({ id: "draft_x" })
      })

      // The queued Z transition ran after the flush settled: the editor shows Z
      // and still only one save ever fired.
      expect(mockSaveDraft).toHaveBeenCalledTimes(1)
      expect(result.current.content).toEqual(makeDoc("Z body"))
    })

    it("follows an id migration without flushing or blanking the editor", () => {
      // A split ack / remote-delete preserve re-keys the SAME draft underneath the
      // composer. The pointer changes value, but the editor's content still belongs
      // to that row — treating it as a repoint would flush to the deleted id and
      // `resetForReinit` mid-typing.
      mockDraftIsLoaded = true
      mockDraftLoadedId = "draft_x"
      mockDraftContentJson = makeDoc("X body")
      const { result, rerender } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      act(() => {
        result.current.handleContentChange(makeDoc("X body and typing"))
      })

      act(() => {
        markDraftMigrated("draft_x", "draft_x2")
        mockDraftLoadedId = "draft_x2"
        rerender()
      })

      expect(result.current.content).toEqual(makeDoc("X body and typing"))
      expect(mockSaveDraft).not.toHaveBeenCalled()

      // Engagement survived: a stale saved body arriving now must not re-fill.
      act(() => {
        mockDraftContentJson = makeDoc("stale saved body")
        rerender()
      })
      expect(result.current.content).toEqual(makeDoc("X body and typing"))
    })

    it("detaches a typed fragment to its own row when a first pointer arrives under an engaged editor", async () => {
      // null → Y with the user mid-typing: the fragment has no identity, so the
      // armed pointer-addressed save would land in Y and destroy its body.
      mockDraftIsLoaded = true
      mockDraftLoadedId = null
      mockDraftContentJson = EMPTY_DOC
      mockSaveDraft.mockResolvedValue(persistedRow("draft_detached"))
      const { result, rerender } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      act(() => {
        result.current.handleContentChange(makeDoc("fragment"))
      })

      await act(async () => {
        mockDraftLoadedId = "draft_y"
        mockDraftContentJson = makeDoc("Y body")
        rerender()
      })

      expect(mockSaveDraft).toHaveBeenCalledTimes(1)
      const [flushedContent, , detachedId] = mockSaveDraft.mock.calls[0]
      expect(flushedContent).toEqual(makeDoc("fragment"))
      // A row id of its own — never Y's, and never the pointer-addressed null.
      expect(typeof detachedId).toBe("string")
      expect(detachedId).not.toBe("draft_y")
      // Y rehydrates intact.
      expect(result.current.content).toEqual(makeDoc("Y body"))
    })

    it("keeps the typed fragment on screen when the detached save could not persist", async () => {
      // Locked E2E scope: `saveDraft` is gated and persists nothing (resolves
      // null). Blanking the editor then would lose the fragment from screen AND
      // disk, so the focused composer keeps it and does not adopt Y.
      mockDraftIsLoaded = true
      mockDraftLoadedId = null
      mockDraftContentJson = EMPTY_DOC
      mockSaveDraft.mockResolvedValue(null)
      const { result, rerender } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      act(() => {
        result.current.handleContentChange(makeDoc("fragment"))
      })

      await act(async () => {
        mockDraftLoadedId = "draft_y"
        mockDraftContentJson = makeDoc("Y body")
        rerender()
      })

      expect(result.current.content).toEqual(makeDoc("fragment"))
      expect(mockClearAttachments).not.toHaveBeenCalled()
    })

    it("drops the armed save without persisting when an engaged editor is empty as the first pointer arrives", async () => {
      // Typed, then deleted back to empty: the debounce is re-armed with an empty
      // doc and a null expected id, so firing it would delete the arriving draft.
      mockDraftIsLoaded = true
      mockDraftLoadedId = null
      mockDraftContentJson = EMPTY_DOC
      const { result, rerender } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      act(() => {
        result.current.handleContentChange(makeDoc("fragment"))
      })
      act(() => {
        result.current.handleContentChange(EMPTY_DOC)
      })

      await act(async () => {
        mockDraftLoadedId = "draft_y"
        mockDraftContentJson = makeDoc("Y body")
        rerender()
      })

      expect(mockCancelPendingSave).toHaveBeenCalledTimes(1)
      expect(mockSaveDraft).not.toHaveBeenCalled()
      // Y is adopted and hydrated into the (empty) editor.
      expect(result.current.content).toEqual(makeDoc("Y body"))
    })
  })
})
