import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useDraftMessage, getDraftMessageKey, upsertLoadedDraft } from "./use-draft-message"
import { ContextRefKinds, type JSONContent } from "@threa/types"
import type { DraftContextRef } from "@/lib/context-bag/types"
import { db } from "@/db"
import { resetDraftStoreCache, seedDraftCacheFromIdb } from "@/stores/draft-store"

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }
const makeDoc = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : undefined }],
})

const workspaceId = "ws_123"
const draftKey = "stream:stream_456"

/** Read back the single loaded draft for a scope (or undefined). */
async function loadedDraft(scope: string) {
  const id = (await db.composerLoaded.get(scope))?.draftId ?? null
  return id ? db.drafts.get(id) : undefined
}

describe("getDraftMessageKey", () => {
  it("should return stream key format for stream type", () => {
    expect(getDraftMessageKey({ type: "stream", streamId: "stream_123" })).toBe("stream:stream_123")
  })

  it("should return thread key format for thread type", () => {
    expect(getDraftMessageKey({ type: "thread", parentMessageId: "msg_456" })).toBe("thread:msg_456")
  })
})

describe("useDraftMessage", () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    resetDraftStoreCache()
    await db.drafts.clear()
    await db.composerLoaded.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("isLoaded state", () => {
    it("should return isLoaded=false while the draft cache is unseeded", () => {
      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))

      expect(result.current.isLoaded).toBe(false)
      expect(result.current.contentJson).toEqual(EMPTY_DOC)
      expect(result.current.attachments).toEqual([])
    })

    it("should return isLoaded=true after the cache is seeded with no data", async () => {
      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))

      await act(async () => {
        await seedDraftCacheFromIdb(workspaceId)
      })

      expect(result.current.isLoaded).toBe(true)
      expect(result.current.contentJson).toEqual(EMPTY_DOC)
      expect(result.current.attachments).toEqual([])
    })

    it("should surface the loaded draft's saved content once seeded", async () => {
      const savedContentJson = makeDoc("Hello world")
      await upsertLoadedDraft(workspaceId, draftKey, {
        contentJson: savedContentJson,
        attachments: [{ id: "attach_1", filename: "test.txt", mimeType: "text/plain", sizeBytes: 100 }],
      })

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))

      expect(result.current.isLoaded).toBe(true)
      expect(result.current.contentJson).toEqual(savedContentJson)
      expect(result.current.attachments).toHaveLength(1)
      expect(result.current.attachments[0].filename).toBe("test.txt")
    })

    it("should return empty state for a scope with no loaded draft", async () => {
      const oldDraftKey = "stream:stream_old"
      const newDraftKey = "stream:stream_new"
      await upsertLoadedDraft(workspaceId, oldDraftKey, {
        contentJson: makeDoc("Old draft"),
        attachments: [{ id: "attach_old", filename: "old.txt", mimeType: "text/plain", sizeBytes: 100 }],
      })

      const { result, rerender } = renderHook(({ key }) => useDraftMessage(workspaceId, key), {
        initialProps: { key: oldDraftKey },
      })

      expect(result.current.attachments).toHaveLength(1)

      rerender({ key: newDraftKey })

      expect(result.current.contentJson).toEqual(EMPTY_DOC)
      expect(result.current.attachments).toEqual([])
    })
  })

  describe("saveDraft", () => {
    it("should persist content as a draft_ row scoped to the key + a loaded pointer", async () => {
      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))
      const newContent = makeDoc("New content")

      await act(async () => {
        await result.current.saveDraft(newContent)
      })

      const persisted = await loadedDraft(draftKey)
      expect(persisted).toMatchObject({ scope: draftKey, workspaceId, contentJson: newContent, attachments: [] })
      expect(persisted!.id.startsWith("draft_")).toBe(true)
    })

    it("never persists a draft for an E2E stream and purges any on disk (E2EE-4)", async () => {
      // A plaintext draft written before the gate existed...
      await upsertLoadedDraft(workspaceId, draftKey, { contentJson: makeDoc("secret"), attachments: [] })

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey, true))

      await act(async () => {
        await result.current.saveDraft(makeDoc("secret plaintext"))
        result.current.saveDraftDebounced(makeDoc("more secret plaintext"))
        await result.current.addAttachment({ id: "att_1", filename: "f", mimeType: "text/plain", sizeBytes: 1 })
      })

      // ...is purged on mount, and nothing new is written to disk.
      await waitFor(async () => expect(await db.drafts.where("scope").equals(draftKey).count()).toBe(0))
      expect(await db.composerLoaded.get(draftKey)).toBeUndefined()
    })

    it("cancels a debounced plaintext save when the stream becomes encrypted mid-flight (E2EE-4 race)", async () => {
      const { result, rerender } = renderHook(
        ({ e2e }: { e2e: boolean }) => useDraftMessage(workspaceId, draftKey, e2e),
        {
          initialProps: { e2e: false },
        }
      )

      act(() => {
        result.current.saveDraftDebounced(makeDoc("typed before the stream was encrypted"))
      })
      rerender({ e2e: true })

      // Past the debounce window: the in-flight save must NOT persist plaintext.
      await new Promise((r) => setTimeout(r, 700))
      expect(await db.drafts.where("scope").equals(draftKey).count()).toBe(0)
    })

    it("should delete the loaded draft when content is empty and no attachments", async () => {
      await upsertLoadedDraft(workspaceId, draftKey, { contentJson: makeDoc("something"), attachments: [] })

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))

      await act(async () => {
        await result.current.saveDraft(EMPTY_DOC)
      })

      expect(await loadedDraft(draftKey)).toBeUndefined()
      expect(await db.composerLoaded.get(draftKey)).toBeUndefined()
    })

    it("should preserve existing attachments when saving content", async () => {
      const existingAttachments = [{ id: "attach_1", filename: "file.txt", mimeType: "text/plain", sizeBytes: 50 }]
      await upsertLoadedDraft(workspaceId, draftKey, { contentJson: makeDoc("x"), attachments: existingAttachments })

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))
      const updatedContent = makeDoc("Updated content")

      await act(async () => {
        await result.current.saveDraft(updatedContent)
      })

      const persisted = await loadedDraft(draftKey)
      expect(persisted).toMatchObject({ contentJson: updatedContent, attachments: existingAttachments })
    })

    it("should preserve existing contextRefs sidecar when saving content (regression: typing wiped the chip)", async () => {
      const existingRefs: DraftContextRef[] = [
        {
          refKind: ContextRefKinds.THREAD,
          streamId: "stream_src",
          fromMessageId: null,
          toMessageId: null,
          originMessageId: null,
          status: "ready",
          fingerprint: null,
          errorMessage: null,
        },
      ]
      await upsertLoadedDraft(workspaceId, draftKey, {
        contentJson: EMPTY_DOC,
        attachments: [],
        contextRefs: existingRefs,
      })

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))
      const updatedContent = makeDoc("user is typing")

      await act(async () => {
        await result.current.saveDraft(updatedContent)
      })

      const persisted = await loadedDraft(draftKey)
      expect(persisted).toMatchObject({ contentJson: updatedContent, attachments: [], contextRefs: existingRefs })
    })

    it("should keep the draft alive when content goes empty but contextRefs is non-empty", async () => {
      const existingRefs: DraftContextRef[] = [
        {
          refKind: ContextRefKinds.THREAD,
          streamId: "stream_src",
          fromMessageId: null,
          toMessageId: null,
          originMessageId: null,
          status: "ready",
          fingerprint: null,
          errorMessage: null,
        },
      ]
      await upsertLoadedDraft(workspaceId, draftKey, {
        contentJson: makeDoc("x"),
        attachments: [],
        contextRefs: existingRefs,
      })

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))

      await act(async () => {
        await result.current.saveDraft(EMPTY_DOC)
      })

      const persisted = await loadedDraft(draftKey)
      expect(persisted).toMatchObject({ contentJson: EMPTY_DOC, contextRefs: existingRefs })
    })
  })

  describe("saveDraftDebounced", () => {
    it("should debounce saves, persisting only the last value", async () => {
      const putSpy = vi.spyOn(db.drafts, "put")
      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))
      const thirdContent = makeDoc("Third")

      act(() => {
        result.current.saveDraftDebounced(makeDoc("First"))
        result.current.saveDraftDebounced(makeDoc("Second"))
        result.current.saveDraftDebounced(thirdContent)
      })

      expect(putSpy).not.toHaveBeenCalled()

      await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1))
      const persisted = await loadedDraft(draftKey)
      expect(persisted?.contentJson).toEqual(thirdContent)
    })
  })

  describe("addAttachment", () => {
    it("should add attachment to an empty (absent) draft", async () => {
      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))
      const attachment = { id: "attach_1", filename: "new.txt", mimeType: "text/plain", sizeBytes: 100 }

      await act(async () => {
        await result.current.addAttachment(attachment)
      })

      const persisted = await loadedDraft(draftKey)
      expect(persisted).toMatchObject({ scope: draftKey, contentJson: EMPTY_DOC, attachments: [attachment] })
    })

    it("should not add a duplicate attachment", async () => {
      const existingAttachment = { id: "attach_1", filename: "existing.txt", mimeType: "text/plain", sizeBytes: 50 }
      await upsertLoadedDraft(workspaceId, draftKey, { contentJson: EMPTY_DOC, attachments: [existingAttachment] })

      const putSpy = vi.spyOn(db.drafts, "put")
      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))

      await act(async () => {
        await result.current.addAttachment(existingAttachment)
      })

      expect(putSpy).not.toHaveBeenCalled()
    })
  })

  describe("removeAttachment", () => {
    it("should remove an attachment from the draft", async () => {
      const attachments = [
        { id: "attach_1", filename: "file1.txt", mimeType: "text/plain", sizeBytes: 50 },
        { id: "attach_2", filename: "file2.txt", mimeType: "text/plain", sizeBytes: 100 },
      ]
      await upsertLoadedDraft(workspaceId, draftKey, { contentJson: makeDoc("Some content"), attachments })

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))

      await act(async () => {
        await result.current.removeAttachment("attach_1")
      })

      const persisted = await loadedDraft(draftKey)
      expect(persisted?.attachments).toEqual([
        { id: "attach_2", filename: "file2.txt", mimeType: "text/plain", sizeBytes: 100 },
      ])
    })

    it("should delete the draft when removing the last attachment and content is empty", async () => {
      const attachment = { id: "attach_1", filename: "file.txt", mimeType: "text/plain", sizeBytes: 50 }
      await upsertLoadedDraft(workspaceId, draftKey, { contentJson: EMPTY_DOC, attachments: [attachment] })

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))

      await act(async () => {
        await result.current.removeAttachment("attach_1")
      })

      expect(await loadedDraft(draftKey)).toBeUndefined()
    })
  })

  describe("clearDraft", () => {
    it("should delete the loaded draft and its pointer", async () => {
      await upsertLoadedDraft(workspaceId, draftKey, { contentJson: makeDoc("x"), attachments: [] })

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))

      await act(async () => {
        await result.current.clearDraft()
      })

      expect(await loadedDraft(draftKey)).toBeUndefined()
      expect(await db.composerLoaded.get(draftKey)).toBeUndefined()
    })

    it("should cancel a pending debounced save", async () => {
      const putSpy = vi.spyOn(db.drafts, "put")
      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))

      act(() => {
        result.current.saveDraftDebounced(makeDoc("Will be cancelled"))
      })

      await act(async () => {
        await result.current.clearDraft()
      })

      await new Promise((r) => setTimeout(r, 700))
      expect(putSpy).not.toHaveBeenCalled()
      expect(await loadedDraft(draftKey)).toBeUndefined()
    })
  })
})
