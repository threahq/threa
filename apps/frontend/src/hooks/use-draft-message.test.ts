import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useDraftMessage, getDraftMessageKey, upsertLoadedDraft, resolveLoadedDraft } from "./use-draft-message"
import { getScopeResolveSeq, resetDraftResolutionGuard } from "@/sync/draft-resolution-guard"
import { ContextRefKinds, type JSONContent } from "@threa/types"
import type { DraftContextRef } from "@/lib/context-bag/types"
import { db } from "@/db"
import { resetDraftStoreCache, seedDraftCacheFromIdb } from "@/stores/draft-store"
import * as currentUserHook from "./use-current-workspace-user-id"
import * as e2eSessionStore from "@/stores/e2e-session-store"
import * as sealDraft from "@/lib/crypto/seal-draft"
import { seedDecryption, clearDecryptCache, getCachedDecryption } from "@/lib/crypto/decrypt-cache"

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }
const makeDoc = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : undefined }],
})

const workspaceId = "ws_123"
const draftKey = "stream:stream_456"

/** A locked E2E session — the default; the composer must not seal/decrypt. */
const LOCKED_SESSION = {
  status: "locked",
  keyId: null,
  publicKey: null,
  privateKey: null,
  deviceTrusted: false,
  error: null,
} as ReturnType<typeof e2eSessionStore.useE2eSession>

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
    resetDraftResolutionGuard()
    await db.drafts.clear()
    await db.composerLoaded.clear()
    await db.pendingOperations.clear()
    // The composer reads the viewer id + E2E session unconditionally now; default
    // them to "no viewer / locked" so the plaintext tests run without an
    // AuthProvider, and override per-test for the unlocked-E2E cases.
    vi.spyOn(currentUserHook, "useCurrentWorkspaceUserId").mockReturnValue(null)
    vi.spyOn(e2eSessionStore, "useE2eSession").mockReturnValue(LOCKED_SESSION)
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

    it("while locked, never persists an E2E draft and purges plaintext on disk (E2EE-4)", async () => {
      // A plaintext draft written before the stream was encrypted...
      await upsertLoadedDraft(workspaceId, draftKey, { contentJson: makeDoc("secret"), attachments: [] })

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey, "stream_e2e_root"))

      await act(async () => {
        await result.current.saveDraft(makeDoc("secret plaintext"))
        result.current.saveDraftDebounced(makeDoc("more secret plaintext"))
        await result.current.addAttachment({ id: "att_1", filename: "f", mimeType: "text/plain", sizeBytes: 1 })
      })

      // ...is purged on mount, and nothing new persists while the session is locked.
      await waitFor(async () => expect(await db.drafts.where("scope").equals(draftKey).count()).toBe(0))
      expect(await db.composerLoaded.get(draftKey)).toBeUndefined()
    })

    it("cancels a debounced plaintext save when the stream becomes encrypted mid-flight (E2EE-4 race)", async () => {
      const { result, rerender } = renderHook(
        ({ e2e }: { e2e: string | undefined }) => useDraftMessage(workspaceId, draftKey, e2e),
        {
          initialProps: { e2e: undefined as string | undefined },
        }
      )

      act(() => {
        result.current.saveDraftDebounced(makeDoc("typed before the stream was encrypted"))
      })
      rerender({ e2e: "stream_e2e_root" })

      // Past the debounce window: the in-flight save reads the live (now encrypted,
      // locked) gate and must NOT persist plaintext.
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

  describe("resolveDraft", () => {
    it("removes the loaded draft locally and enqueues a CAS resolve for a confirmed draft", async () => {
      await db.pendingOperations.clear()
      // A draft the server has already confirmed at version 2.
      await db.drafts.put({
        id: "draft_confirmed",
        workspaceId,
        scope: draftKey,
        contentJson: makeDoc("sent"),
        attachments: [],
        baseVersion: 2,
        clientUpdatedAt: Date.now(),
      })
      await db.composerLoaded.put({ scope: draftKey, workspaceId, draftId: "draft_confirmed" })

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))
      await act(async () => {
        await result.current.resolveDraft()
      })

      expect(await db.drafts.get("draft_confirmed")).toBeUndefined()
      expect(await db.composerLoaded.get(draftKey)).toBeUndefined()
      const resolves = await db.pendingOperations.where("type").equals("resolve_draft").toArray()
      expect(resolves).toHaveLength(1)
      expect(resolves[0]?.payload).toMatchObject({ draftId: "draft_confirmed", expectedVersion: 2 })
    })

    it("does not enqueue a server resolve for a never-synced draft (nothing to resolve)", async () => {
      await db.pendingOperations.clear()
      await upsertLoadedDraft(workspaceId, draftKey, { contentJson: makeDoc("x"), attachments: [] })

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey))
      await act(async () => {
        await result.current.resolveDraft()
      })

      expect(await loadedDraft(draftKey)).toBeUndefined()
      expect(await db.pendingOperations.where("type").equals("resolve_draft").count()).toBe(0)
    })

    it("a stale debounced save (started before resolve-on-send) does NOT resurrect the draft", async () => {
      // The exact production race: the user's last keystroke armed a debounced
      // save which captured the scope's resolve seq; the send tears the draft down
      // (resolveLoadedDraft bumps the seq), then the stale save fires with the
      // just-sent content. The create branch sees the advanced seq and drops it —
      // without that, it re-creates the draft + pointer and the editor refills.
      await db.drafts.put({
        id: "draft_confirmed",
        workspaceId,
        scope: draftKey,
        contentJson: makeDoc("sent message"),
        attachments: [],
        baseVersion: 2,
        clientUpdatedAt: Date.now(),
      })
      await db.composerLoaded.put({ scope: draftKey, workspaceId, draftId: "draft_confirmed" })

      const observedResolveSeq = getScopeResolveSeq(draftKey) // captured when the save began
      await resolveLoadedDraft(workspaceId, draftKey)
      // Stale save fires (its keystroke predates the send): no loaded pointer now,
      // so this takes the create path — which the guard must refuse.
      await upsertLoadedDraft(
        workspaceId,
        draftKey,
        { contentJson: makeDoc("sent message"), attachments: [] },
        undefined,
        { observedResolveSeq }
      )

      expect(await db.composerLoaded.get(draftKey)).toBeUndefined()
      const scoped = (await db.drafts.toArray()).filter((d) => d.scope === draftKey)
      expect(scoped).toHaveLength(0)
    })

    it("allows a fresh save started AFTER the send to create a new draft", async () => {
      await db.drafts.put({
        id: "draft_confirmed",
        workspaceId,
        scope: draftKey,
        contentJson: makeDoc("sent message"),
        attachments: [],
        baseVersion: 2,
        clientUpdatedAt: Date.now(),
      })
      await db.composerLoaded.put({ scope: draftKey, workspaceId, draftId: "draft_confirmed" })

      await resolveLoadedDraft(workspaceId, draftKey)
      // The user types a new message: this save begins AFTER the resolve, so it
      // observes the already-advanced seq and is not treated as stale.
      const observedResolveSeq = getScopeResolveSeq(draftKey)
      await upsertLoadedDraft(
        workspaceId,
        draftKey,
        { contentJson: makeDoc("a different message"), attachments: [] },
        undefined,
        { observedResolveSeq }
      )

      expect(await db.composerLoaded.get(draftKey)).toBeDefined()
    })

    it("a create from a non-debounce path (no observed seq) is never blocked post-send", async () => {
      // share-target, attachments, DM-scope migration, etc. call upsertLoadedDraft
      // without an observed seq, so a just-resolved scope must not silently drop
      // their content (the data-loss regression the UX review caught).
      await db.drafts.put({
        id: "draft_confirmed",
        workspaceId,
        scope: draftKey,
        contentJson: makeDoc("sent message"),
        attachments: [],
        baseVersion: 2,
        clientUpdatedAt: Date.now(),
      })
      await db.composerLoaded.put({ scope: draftKey, workspaceId, draftId: "draft_confirmed" })

      await resolveLoadedDraft(workspaceId, draftKey)
      await upsertLoadedDraft(workspaceId, draftKey, { contentJson: makeDoc("shared content"), attachments: [] })

      expect(await db.composerLoaded.get(draftKey)).toBeDefined()
    })
  })

  describe("E2E drafts (unlocked session)", () => {
    const e2eStreamId = "stream_e2e_root"
    const unlockedSession = {
      status: "unlocked",
      keyId: "ek_test",
      publicKey: null,
      privateKey: {} as CryptoKey,
      deviceTrusted: true,
      error: null,
    } as ReturnType<typeof e2eSessionStore.useE2eSession>

    beforeEach(() => {
      clearDecryptCache()
      vi.spyOn(currentUserHook, "useCurrentWorkspaceUserId").mockReturnValue("user_1")
      vi.spyOn(e2eSessionStore, "useE2eSession").mockReturnValue(unlockedSession)
    })

    /** Persist a sealed (E2E) draft loaded into the composer for the scope. */
    async function putSealedLoaded(id: string) {
      await db.drafts.put({
        id,
        workspaceId,
        scope: draftKey,
        contentJson: EMPTY_DOC,
        attachments: [],
        ciphertext: "ct_sealed",
        envelope: { v: 2 },
        e2eVersion: 2,
        baseVersion: 1,
        clientUpdatedAt: Date.now(),
      })
      await db.composerLoaded.put({ scope: draftKey, workspaceId, draftId: id })
      await seedDraftCacheFromIdb(workspaceId)
    }

    it("seals the body and persists ciphertext only — never plaintext at rest (E2EE-4)", async () => {
      const sealSpy = vi.spyOn(sealDraft, "sealDraftContent").mockResolvedValue({
        ciphertext: "ct_sealed",
        envelope: { v: 2 },
        e2eVersion: 2,
        contentMarkdown: "top secret",
        attachmentRefs: [],
      })

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey, e2eStreamId))

      await act(async () => {
        await result.current.saveDraft(makeDoc("top secret"))
      })

      const persisted = await loadedDraft(draftKey)
      expect(persisted?.ciphertext).toBe("ct_sealed")
      expect(persisted?.e2eVersion).toBe(2)
      // The plaintext body never lands on disk — only the empty placeholder does.
      expect(persisted?.contentJson).toEqual(EMPTY_DOC)
      expect(sealSpy).toHaveBeenCalledWith(
        expect.objectContaining({ senderId: "user_1", streamId: e2eStreamId, contentJson: makeDoc("top secret") })
      )
      // And it is queued to roam to the author's other devices.
      expect(await db.pendingOperations.where("type").equals("upsert_draft").count()).toBe(1)
    })

    it("surfaces the decrypted body on load via the shared decrypt cache", async () => {
      await putSealedLoaded("draft_sealed")
      // The plaintext is in the shared cache — seeded by the authoring device's
      // save, or (on a fresh device) populated by the read path's decrypt. Either
      // way the composer reads it back the same way a message does.
      seedDecryption("draft_sealed", { contentMarkdown: "decrypted body", contentJson: makeDoc("decrypted body") })

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey, e2eStreamId))

      await waitFor(() => expect(result.current.isLoaded).toBe(true))
      expect(result.current.contentJson).toEqual(makeDoc("decrypted body"))
      expect(result.current.isDecrypting).toBe(false)
    })

    it("reports a locked sealed draft as empty (not stuck), without losing the row", async () => {
      vi.spyOn(e2eSessionStore, "useE2eSession").mockReturnValue(LOCKED_SESSION)
      await putSealedLoaded("draft_sealed")

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey, e2eStreamId))

      await waitFor(() => expect(result.current.isLoaded).toBe(true))
      expect(result.current.isDecrypting).toBe(false)
      expect(result.current.contentJson).toEqual(EMPTY_DOC)
      // The sealed row is kept (only plaintext rows are purged) so it decrypts on unlock.
      expect(await db.drafts.get("draft_sealed")).toBeDefined()
    })

    it("re-seeds the decrypt cache on every edit of the same draft id (no stale first edit)", async () => {
      // A draft id is stable across edits, so the seal path must REPLACE the
      // cached plaintext each time. Without `invalidateDecryption`, `seedDecryption`
      // would short-circuit on the already-decrypted id and the read path would
      // serve the FIRST edit forever — the latest keystrokes look lost on remount
      // (safe in the sealed row at rest, but never displayed).
      vi.spyOn(sealDraft, "sealDraftContent").mockResolvedValue({
        ciphertext: "ct",
        envelope: { v: 2 },
        e2eVersion: 2,
        contentMarkdown: "x",
        attachmentRefs: [],
      })
      await seedDraftCacheFromIdb(workspaceId)

      await upsertLoadedDraft(
        workspaceId,
        draftKey,
        { contentJson: makeDoc("first edit"), attachments: [] },
        { senderId: "user_1", streamId: e2eStreamId }
      )
      const id = (await db.composerLoaded.get(draftKey))!.draftId!
      expect(getCachedDecryption(id)?.content?.contentJson).toEqual(makeDoc("first edit"))

      await upsertLoadedDraft(
        workspaceId,
        draftKey,
        { contentJson: makeDoc("second edit"), attachments: [] },
        { senderId: "user_1", streamId: e2eStreamId }
      )
      expect(getCachedDecryption(id)?.content?.contentJson).toEqual(makeDoc("second edit"))
    })

    it("keeps content in the composer (no plaintext written) when the session is locked", async () => {
      vi.spyOn(e2eSessionStore, "useE2eSession").mockReturnValue(LOCKED_SESSION)
      const sealSpy = vi.spyOn(sealDraft, "sealDraftContent")

      const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey, e2eStreamId))

      await act(async () => {
        await result.current.saveDraft(makeDoc("secret while locked"))
      })

      expect(sealSpy).not.toHaveBeenCalled()
      expect(await db.drafts.where("scope").equals(draftKey).count()).toBe(0)
    })

    // Stage 4d — attachments roam sealed inside the body's ciphertext.
    describe("attachments (Stage 4d)", () => {
      const ref = (id: string, filename: string, sizeBytes: number) => ({
        attachmentId: id,
        key: "AAAA",
        iv: "BBBB",
        filename,
        mimeType: "text/plain",
        sizeBytes,
      })
      const sealMock = (attachmentRefs: ReturnType<typeof ref>[] = []) =>
        vi.spyOn(sealDraft, "sealDraftContent").mockResolvedValue({
          ciphertext: "ct",
          envelope: { v: 2 },
          e2eVersion: 2,
          contentMarkdown: "body",
          attachmentRefs,
        })

      it("seals the attachment ids into the body (passes attachmentIds to the seal, never at rest)", async () => {
        const sealSpy = sealMock()
        const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey, e2eStreamId))
        const attachment = { id: "att_1", filename: "f.txt", mimeType: "text/plain", sizeBytes: 10 }

        await act(async () => {
          await result.current.saveDraft(makeDoc("body"), [attachment])
        })

        expect(sealSpy).toHaveBeenCalledWith(expect.objectContaining({ attachmentIds: ["att_1"] }))
        // E2EE-4: the plaintext attachment linkage never lands on disk.
        const persisted = await loadedDraft(draftKey)
        expect(persisted?.attachments).toEqual([])
      })

      it("surfaces decrypted attachments recovered from the refs, not the empty at-rest row", async () => {
        await putSealedLoaded("draft_sealed")
        seedDecryption("draft_sealed", {
          contentMarkdown: "hi",
          contentJson: makeDoc("hi"),
          attachmentRefs: [ref("att_7", "p.pdf", 99)],
          sources: [],
        })

        const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey, e2eStreamId))

        await waitFor(() => expect(result.current.isLoaded).toBe(true))
        expect(result.current.attachments).toEqual([
          { id: "att_7", filename: "p.pdf", mimeType: "text/plain", sizeBytes: 99 },
        ])
      })

      it("addAttachment re-seals with the new attachment, reading the body from the decrypt cache", async () => {
        await putSealedLoaded("draft_sealed")
        seedDecryption("draft_sealed", {
          contentMarkdown: "hi",
          contentJson: makeDoc("hi"),
          attachmentRefs: [],
          sources: [],
        })
        const sealSpy = sealMock([ref("att_9", "a.png", 5)])

        const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey, e2eStreamId))
        await waitFor(() => expect(result.current.isLoaded).toBe(true))

        await act(async () => {
          await result.current.addAttachment({ id: "att_9", filename: "a.png", mimeType: "image/png", sizeBytes: 5 })
        })

        expect(sealSpy).toHaveBeenCalledWith(
          expect.objectContaining({ contentJson: makeDoc("hi"), attachmentIds: ["att_9"] })
        )
      })

      it("a content-only save preserves the draft's already-sealed attachments", async () => {
        await putSealedLoaded("draft_sealed")
        seedDecryption("draft_sealed", {
          contentMarkdown: "old",
          contentJson: makeDoc("old"),
          attachmentRefs: [ref("att_3", "x.txt", 3)],
          sources: [],
        })
        const sealSpy = sealMock([ref("att_3", "x.txt", 3)])

        const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey, e2eStreamId))
        await waitFor(() => expect(result.current.isLoaded).toBe(true))

        // A keystroke save carries no attachments arg — the sealed set must survive.
        await act(async () => {
          await result.current.saveDraft(makeDoc("new"))
        })

        expect(sealSpy).toHaveBeenCalledWith(expect.objectContaining({ attachmentIds: ["att_3"] }))
      })

      it("removeAttachment re-seals without the removed id", async () => {
        await putSealedLoaded("draft_sealed")
        seedDecryption("draft_sealed", {
          contentMarkdown: "body",
          contentJson: makeDoc("body"),
          attachmentRefs: [ref("att_a", "a", 1), ref("att_b", "b", 1)],
          sources: [],
        })
        const sealSpy = sealMock([ref("att_b", "b", 1)])

        const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey, e2eStreamId))
        await waitFor(() => expect(result.current.isLoaded).toBe(true))

        await act(async () => {
          await result.current.removeAttachment("att_a")
        })

        expect(sealSpy).toHaveBeenCalledWith(expect.objectContaining({ attachmentIds: ["att_b"] }))
      })

      it("removeAttachment clears the draft when it leaves no body and no attachments", async () => {
        await putSealedLoaded("draft_sealed")
        seedDecryption("draft_sealed", {
          contentMarkdown: "",
          contentJson: EMPTY_DOC,
          attachmentRefs: [ref("att_only", "only", 1)],
          sources: [],
        })
        const sealSpy = sealMock()

        const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey, e2eStreamId))
        await waitFor(() => expect(result.current.isLoaded).toBe(true))

        await act(async () => {
          await result.current.removeAttachment("att_only")
        })

        expect(sealSpy).not.toHaveBeenCalled()
        expect(await loadedDraft(draftKey)).toBeUndefined()
      })

      it("does not persist an attachment while the session is locked (E2EE-4)", async () => {
        vi.spyOn(e2eSessionStore, "useE2eSession").mockReturnValue(LOCKED_SESSION)
        const sealSpy = vi.spyOn(sealDraft, "sealDraftContent")

        const { result } = renderHook(() => useDraftMessage(workspaceId, draftKey, e2eStreamId))

        await act(async () => {
          await result.current.addAttachment({ id: "att_x", filename: "x", mimeType: "text/plain", sizeBytes: 1 })
        })

        expect(sealSpy).not.toHaveBeenCalled()
        expect(await db.drafts.where("scope").equals(draftKey).count()).toBe(0)
      })
    })
  })
})
