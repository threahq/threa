import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useDraftComposer } from "./use-draft-composer"
import type { JSONContent } from "@threa/types"
import * as useDraftMessageModule from "./use-draft-message"
import * as useAttachmentsModule from "./use-attachments"

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
const mockClearAttachments = vi.fn()
const mockRestoreAttachments = vi.fn()

describe("useDraftComposer", () => {
  const workspaceId = "ws_123"
  const draftKey = "stream:stream_456"
  const scopeId = "stream_456"

  beforeEach(() => {
    vi.restoreAllMocks()
    mockSaveDraft.mockReset()
    mockSaveDraftDebounced.mockReset()
    mockAddDraftAttachment.mockReset()
    mockRemoveDraftAttachment.mockReset()
    mockClearDraft.mockReset()
    mockResolveDraft.mockReset()
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
          uploadedIds: mockPendingAttachments
            .filter((a) => a.status === "uploaded" && !a.id.startsWith("temp_"))
            .map((a) => a.id),
          isUploading: mockPendingAttachments.some((a) => a.status === "uploading"),
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

      // Change scope
      rerender({ scopeId: "stream_2" })

      expect(result.current.content).toEqual(EMPTY_DOC)
    })

    it("should clear attachments when scopeId changes", () => {
      const { rerender } = renderHook(({ scopeId }) => useDraftComposer({ workspaceId, draftKey, scopeId }), {
        initialProps: { scopeId: "stream_1" },
      })

      // Change scope
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

    it("should be false while uploads are still in progress", () => {
      mockPendingAttachments = [
        { id: "temp_1", filename: "test.txt", mimeType: "text/plain", sizeBytes: 100, status: "uploading" },
      ]

      const { result } = renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId }))

      act(() => {
        result.current.setContent(makeDoc("Hello"))
      })

      expect(result.current.canSend).toBe(false)
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
  })
})
