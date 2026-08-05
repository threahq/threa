import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { createElement, type ReactNode } from "react"
import type { JSONContent } from "@threa/types"
import { db, type CachedDraft } from "@/db"
import { resetDraftStoreCache, seedDraftCacheFromIdb } from "@/stores/draft-store"
import { resetDraftResolutionGuard } from "@/sync/draft-resolution-guard"
import { __clearBoardDraftContextRegistry } from "./use-board-draft-context"
import { useDraftComposer } from "./use-draft-composer"
import { useStashComposer, useStashParamDraftRow } from "./use-stash-composer"
import { upsertLoadedDraft, stashLoadedDraft, restoreStashedDraftToComposer } from "./use-draft-message"
import { clearComposerTarget } from "./use-composer-target"
import * as draftMessageModule from "./use-draft-message"
import * as currentUserHook from "./use-current-workspace-user-id"
import * as e2eSessionStore from "@/stores/e2e-session-store"

// Hook-level test (renderHook), like its siblings use-draft-message.test.ts and
// use-draft-composer.test.ts: it pins the no-limbo DATA invariant of restore
// against the real data layer (fake-indexeddb). It deliberately does not mount a
// component — RichEditor is mocked suite-wide, so a mounted flow wouldn't exercise
// the real editor sync anyway; that hop is unit-tested in apply-external-content.test.ts.
// The only seams are the viewer id + E2E session, defaulted to "no viewer / locked"
// so the plaintext path runs without an AuthProvider.
const LOCKED_SESSION = {
  status: "locked",
  keyId: null,
  publicKey: null,
  privateKey: null,
  deviceTrusted: false,
  error: null,
} as ReturnType<typeof e2eSessionStore.useE2eSession>

const workspaceId = "ws_123"
const streamId = "stream_456"
const draftKey = `stream:${streamId}`

/**
 * A faithful "large message with an attachment": several text blocks plus an
 * inline `attachmentReference` chip — the shape of the real scratchpad draft
 * that failed to restore (a pasted image embedded in a multi-paragraph note).
 */
const BIG_BODY: JSONContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "First paragraph of a long note." }] },
    { type: "paragraph", content: [{ type: "text", text: "Second paragraph with more detail." }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Here is the screenshot " },
        {
          type: "attachmentReference",
          attrs: {
            id: "attach_big",
            filename: "pasted-image-1.png",
            mimeType: "image/png",
            sizeBytes: 380784,
            status: "uploaded",
            imageIndex: 1,
            error: null,
          },
        },
      ],
    },
    { type: "paragraph", content: [{ type: "text", text: "Closing thoughts." }] },
  ],
}
const BIG_ATTACHMENT = { id: "attach_big", filename: "pasted-image-1.png", mimeType: "image/png", sizeBytes: 380784 }
const AMBIENT_BODY: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "ambient draft" }] }],
}

function wrapper({ children }: { children: ReactNode }) {
  return createElement(MemoryRouter, { initialEntries: ["/"] }, children)
}

function useRestoreHarness(key: string = draftKey, scopeId: string = streamId) {
  const composer = useDraftComposer({ workspaceId, draftKey: key, scopeId })
  const stash = useStashComposer(composer, workspaceId, key)
  return { composer, stash }
}

describe("stash restore — no-limbo invariant (real data layer)", () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    resetDraftStoreCache()
    resetDraftResolutionGuard()
    await db.drafts.clear()
    await db.composerLoaded.clear()
    await db.pendingOperations.clear()
    vi.spyOn(currentUserHook, "useCurrentWorkspaceUserId").mockReturnValue(null)
    vi.spyOn(e2eSessionStore, "useE2eSession").mockReturnValue(LOCKED_SESSION)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * Seed the scope with a stashed "big" draft (body + inline attachment) and a
   * separate loaded ambient draft — the exact shape of the reported bug (a stash
   * pile where the user restores the long, attachment-carrying entry).
   */
  async function seedStashAndAmbient(): Promise<{ bigId: string; ambientId: string }> {
    const big = await upsertLoadedDraft(workspaceId, draftKey, {
      contentJson: BIG_BODY,
      attachments: [BIG_ATTACHMENT],
    })
    await stashLoadedDraft(workspaceId, draftKey) // detach -> big becomes a stash entry
    const ambient = await upsertLoadedDraft(workspaceId, draftKey, { contentJson: AMBIENT_BODY, attachments: [] })
    await seedDraftCacheFromIdb(workspaceId)
    return { bigId: big.id, ambientId: ambient.id }
  }

  it("restores the big draft's body into the composer AND keeps the row recoverable", async () => {
    const { bigId, ambientId } = await seedStashAndAmbient()

    const { result } = renderHook(() => useRestoreHarness(), { wrapper })

    // Composer starts on the ambient draft.
    await waitFor(() => expect(result.current.composer.content).toEqual(AMBIENT_BODY))

    await act(async () => {
      await result.current.stash.handleRestoreStashed(bigId)
    })

    // 1) The restored body is VISIBLE in the composer (not blank) — no limbo.
    await waitFor(() => expect(result.current.composer.content).toEqual(BIG_BODY))
    // 2) Its attachment chip came back with it.
    await waitFor(() => expect(result.current.composer.pendingAttachments.map((a) => a.id)).toContain("attach_big"))
    // 3) The draft row was never destroyed — it is still on disk and now the loaded one.
    expect(await db.drafts.get(bigId)).toBeDefined()
    expect((await db.composerLoaded.get(draftKey))?.draftId).toBe(bigId)
    // 4) The previously-loaded ambient draft is preserved as a stash sibling (swap, not clobber).
    await waitFor(() => expect(result.current.stash.drafts.some((d) => d.id === ambientId)).toBe(true))
  })

  it("refuses to restore a foreign row into a host whose home stream is unresolvable", async () => {
    const { bigId } = await seedStashAndAmbient()
    const restoreSpy = vi.spyOn(draftMessageModule, "restoreStashedDraftToComposer")
    const foreignKey = "board:reply:conv_1"

    // Nothing is cached for `conv_1`, so the host's home stream doesn't resolve
    // and it cannot be confirmed plaintext + active. An unconfirmable host never
    // takes another scope's row (INV-11), adopt or move.
    const { result } = renderHook(() => useRestoreHarness(foreignKey, foreignKey), { wrapper })
    await waitFor(() => expect(result.current.composer.isLoaded).toBe(true))

    await act(async () => {
      await result.current.stash.handleRestoreStashed(bigId)
    })

    expect(restoreSpy).not.toHaveBeenCalled()
    expect((await db.composerLoaded.get(foreignKey))?.draftId).not.toBe(bigId)
    expect((await db.drafts.get(bigId))?.scope).toBe(draftKey)
  })

  it("?stash= auto-restore is consumed only by the host whose scope owns the row", async () => {
    const { bigId } = await seedStashAndAmbient()
    const foreignKey = "board:reply:conv_1"

    function urlWrapper({ children }: { children: ReactNode }) {
      return createElement(MemoryRouter, { initialEntries: [`/?stash=${bigId}`] }, children)
    }

    // A host on a DIFFERENT scope must not consume the param: pointing its own
    // loaded slot at the foreign row would split one draft across two composers.
    const foreign = renderHook(() => useRestoreHarness(foreignKey, foreignKey), { wrapper: urlWrapper })
    await waitFor(() => expect(foreign.result.current.composer.isLoaded).toBe(true))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect((await db.composerLoaded.get(foreignKey))?.draftId).not.toBe(bigId)
    foreign.unmount()

    // The owning host consumes it and checks the row out.
    renderHook(() => useRestoreHarness(), { wrapper: urlWrapper })
    await waitFor(async () => expect((await db.composerLoaded.get(draftKey))?.draftId).toBe(bigId))
  })

  it("restores exactly once when two composers are mounted on the same scope", async () => {
    const { bigId, ambientId } = await seedStashAndAmbient()

    function urlWrapper({ children }: { children: ReactNode }) {
      return createElement(MemoryRouter, { initialEntries: [`/?stash=${bigId}`] }, children)
    }

    // A board card and the conversation panel's footer are the standing case:
    // both mount the same scope, so membership alone let both restore — the
    // second restore would stash the first's just-restored row straight back.
    const restoreSpy = vi.spyOn(draftMessageModule, "restoreStashedDraftToComposer")
    const { result } = renderHook(() => ({ first: useRestoreHarness(), second: useRestoreHarness() }), {
      wrapper: urlWrapper,
    })
    await waitFor(() => expect(result.current.first.composer.isLoaded).toBe(true))
    await waitFor(() => expect(result.current.second.composer.isLoaded).toBe(true))

    expect(result.current.first.composer.isStashClaimant).toBe(true)
    expect(result.current.second.composer.isStashClaimant).toBe(false)

    await waitFor(async () => expect((await db.composerLoaded.get(draftKey))?.draftId).toBe(bigId))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    // One restore, not two: the non-claimant left the param alone.
    expect(restoreSpy.mock.calls.map((call) => call[2])).toEqual([bigId])
    expect((await db.composerLoaded.get(draftKey))?.draftId).toBe(bigId)
    expect(await db.drafts.get(ambientId)).toBeDefined()
  })

  // The conversation panel keys "should I pop the footer composer open?" on this
  // flag. Without it, revisiting a deep link whose draft is already checked out
  // re-opens and refocuses the composer for a restore that has nothing left to do.
  it("reports a deep-linked row as already loaded once its own scope holds it", async () => {
    const { bigId } = await seedStashAndAmbient()

    function urlWrapper({ children }: { children: ReactNode }) {
      return createElement(MemoryRouter, { initialEntries: [`/?stash=${bigId}`] }, children)
    }

    // No composer harness here: mounting one would consume the param itself and
    // race the assertion. The flag is read by hosts that only OBSERVE the param.
    const { result } = renderHook(() => useStashParamDraftRow(workspaceId), { wrapper: urlWrapper })
    await waitFor(() => expect(result.current?.draftId).toBe(bigId))
    expect(result.current?.isLoadedForScope).toBe(false)

    await act(async () => {
      await restoreStashedDraftToComposer(workspaceId, draftKey, bigId)
      await seedDraftCacheFromIdb(workspaceId)
    })
    await waitFor(() => expect(result.current?.isLoadedForScope).toBe(true))
  })
})

// ---------------------------------------------------------------------------
// Chunk 4: restoring a row that belongs to another surface.
// ---------------------------------------------------------------------------

const aoWorkspaceId = "ws_adopt"
const aoStreamId = "stream_ao"
const aoHostScope = `stream:${aoStreamId}`
const aoConversationId = "conv_ao"
const aoConversationScope = `board:reply:${aoConversationId}`

function seedAoStream(overrides: Record<string, unknown> = {}): Promise<unknown> {
  return db.streams.put({
    id: aoStreamId,
    workspaceId: aoWorkspaceId,
    type: "channel",
    visibility: "private",
    rootStreamId: null,
    archivedAt: null,
    ...overrides,
  } as never)
}

function seedAoConversation(): Promise<unknown> {
  return db.conversations.put({
    id: aoConversationId,
    workspaceId: aoWorkspaceId,
    _lastActivityMs: 1,
    _cachedAt: 1,
    conversation: { id: aoConversationId, streamId: aoStreamId, messageIds: ["msg_1", "msg_2"] },
    openingMessage: { id: "msg_1" },
    recentMessages: [],
  } as never)
}

function aoDraft(id: string, scope: string, extra: Partial<CachedDraft> = {}): CachedDraft {
  return {
    id,
    workspaceId: aoWorkspaceId,
    scope,
    contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: id }] }] },
    attachments: [],
    clientUpdatedAt: 1000,
    baseVersion: 7,
    ...extra,
  } as CachedDraft
}

function useAoHarness(key: string, targetHost?: string) {
  const composer = useDraftComposer({ workspaceId: aoWorkspaceId, draftKey: key, scopeId: key })
  const stash = useStashComposer(
    composer,
    aoWorkspaceId,
    key,
    // Stands in for `message-input`'s disarm, which also clears its gesture latch;
    // that half is pinned in `message-input.composer-target.test.tsx`.
    targetHost ? { targetHost, disarmTarget: () => clearComposerTarget(targetHost) } : undefined
  )
  return { composer, stash }
}

async function upsertOpsFor(draftId: string) {
  const ops = await db.pendingOperations.where("type").equals("upsert_draft").toArray()
  return ops.filter((op) => op.payload.draftId === draftId)
}

describe("restoring a draft that belongs to another surface (adopt vs move)", () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    resetDraftStoreCache()
    resetDraftResolutionGuard()
    __clearBoardDraftContextRegistry()
    await db.drafts.clear()
    await db.composerLoaded.clear()
    await db.composerTarget.clear()
    await db.pendingOperations.clear()
    await db.streams.clear()
    await db.conversations.clear()
    vi.spyOn(currentUserHook, "useCurrentWorkspaceUserId").mockReturnValue(null)
    vi.spyOn(e2eSessionStore, "useE2eSession").mockReturnValue(LOCKED_SESSION)
    await seedAoStream()
    await seedAoConversation()
  })

  afterEach(() => {
    __clearBoardDraftContextRegistry()
    vi.restoreAllMocks()
  })

  it("adopts a conversation's draft in the timeline: the row never moves, the host targets it", async () => {
    await db.drafts.bulkAdd([aoDraft("draft_conv", aoConversationScope), aoDraft("draft_host", aoHostScope)])
    await db.composerLoaded.put({ scope: aoHostScope, workspaceId: aoWorkspaceId, draftId: "draft_host" })
    await seedDraftCacheFromIdb(aoWorkspaceId)

    const { result } = renderHook(() => useAoHarness(aoHostScope, aoHostScope), { wrapper })
    await waitFor(() => expect(result.current.stash.drafts.map((d) => d.id)).toContain("draft_conv"))

    await act(async () => {
      await result.current.stash.handleRestoreStashed("draft_conv")
    })

    // The row keeps its filing — this is the whole point of the feature.
    expect((await db.drafts.get("draft_conv"))?.scope).toBe(aoConversationScope)
    expect(await upsertOpsFor("draft_conv")).toHaveLength(0)
    // Checked out under its OWN scope, with the host pointed at it — that durable
    // target is what raises the "Replying in <C>" strip and files the send into C.
    expect((await db.composerLoaded.get(aoConversationScope))?.draftId).toBe("draft_conv")
    expect((await db.composerTarget.get(aoHostScope))?.scope).toBe(aoConversationScope)
    // The stream's own draft is untouched, still checked out under its own scope.
    expect((await db.composerLoaded.get(aoHostScope))?.draftId).toBe("draft_host")
  })

  // The timeline holds a `board:branch-reply:` target exactly as it holds a
  // `board:reply:` one (`message-input` derives `targetConversationId` from
  // both), so moving one would rewrite a branch draft's scope to the channel and
  // destroy the filing this feature exists to keep — with no undo.
  it("adopts a branch reply's draft in the timeline instead of moving it", async () => {
    const branchScope = `board:branch-reply:${aoConversationId}`
    await db.drafts.bulkAdd([aoDraft("draft_branch", branchScope), aoDraft("draft_host", aoHostScope)])
    await db.composerLoaded.put({ scope: aoHostScope, workspaceId: aoWorkspaceId, draftId: "draft_host" })
    await seedDraftCacheFromIdb(aoWorkspaceId)

    const { result } = renderHook(() => useAoHarness(aoHostScope, aoHostScope), { wrapper })
    await waitFor(() => expect(result.current.stash.drafts.map((d) => d.id)).toContain("draft_branch"))

    await act(async () => {
      expect(await result.current.stash.handleRestoreStashed("draft_branch")).toEqual({ ok: true })
    })

    // The row did NOT move: same scope, no re-scoping push.
    expect((await db.drafts.get("draft_branch"))?.scope).toBe(branchScope)
    expect(await upsertOpsFor("draft_branch")).toHaveLength(0)
    // Checked out under its own scope, with the timeline targeted at it — the
    // strip and the branch-filed send both read that target.
    expect((await db.composerLoaded.get(branchScope))?.draftId).toBe("draft_branch")
    expect((await db.composerTarget.get(aoHostScope))?.scope).toBe(branchScope)
    expect((await db.composerLoaded.get(aoHostScope))?.draftId).toBe("draft_host")
  })

  it("adopting the host's own scope while armed elsewhere is a disarm, not a move", async () => {
    await db.drafts.bulkAdd([aoDraft("draft_conv", aoConversationScope), aoDraft("draft_host", aoHostScope)])
    await db.composerTarget.put({ host: aoHostScope, workspaceId: aoWorkspaceId, scope: aoConversationScope })
    await db.composerLoaded.put({ scope: aoConversationScope, workspaceId: aoWorkspaceId, draftId: "draft_conv" })
    await seedDraftCacheFromIdb(aoWorkspaceId)

    // The armed timeline: its stash host is the conversation's scope.
    const { result } = renderHook(() => useAoHarness(aoConversationScope, aoHostScope), { wrapper })
    await waitFor(() => expect(result.current.stash.drafts.map((d) => d.id)).toContain("draft_host"))

    await act(async () => {
      await result.current.stash.handleRestoreStashed("draft_host")
    })

    expect((await db.drafts.get("draft_host"))?.scope).toBe(aoHostScope)
    expect(await db.composerTarget.get(aoHostScope)).toBeUndefined()
    expect((await db.composerLoaded.get(aoHostScope))?.draftId).toBe("draft_host")
  })

  it("moves a stream draft into a conversation composer, preserving the row and forcing the push", async () => {
    await db.drafts.bulkAdd([aoDraft("draft_stream", aoHostScope), aoDraft("draft_host", aoConversationScope)])
    await db.composerLoaded.put({ scope: aoConversationScope, workspaceId: aoWorkspaceId, draftId: "draft_host" })
    // A push snapshotted before the move whose claim is not visible yet: the
    // worker claims an op and snapshots the row in separate transactions, so
    // "never attempted" is exactly what an in-flight push looks like here.
    await db.pendingOperations.add({
      id: "op_inflight",
      workspaceId: aoWorkspaceId,
      type: "upsert_draft",
      payload: { draftId: "draft_stream", writeId: "write_inflight" },
      createdAt: 1,
      retryCount: 0,
    } as never)
    await seedDraftCacheFromIdb(aoWorkspaceId)

    // The board's conversation composer can't be un-armed, so it takes the row.
    const { result } = renderHook(() => useAoHarness(aoConversationScope), { wrapper })
    await waitFor(() => expect(result.current.stash.drafts.map((d) => d.id)).toContain("draft_stream"))

    await act(async () => {
      await result.current.stash.handleRestoreStashed("draft_stream")
    })

    // Row-preserving: same id, same baseVersion, only the scope changed.
    const moved = await db.drafts.get("draft_stream")
    expect(moved).toMatchObject({ id: "draft_stream", scope: aoConversationScope, baseVersion: 7 })
    // A FRESH op carrying the in-flight lineage — never a coalesce onto the
    // doomed one, whose completion would lose the scope change server-side.
    const ops = await upsertOpsFor("draft_stream")
    expect(ops).toHaveLength(1)
    expect(ops[0].id).not.toBe("op_inflight")
    expect(ops[0].startedAt).toBeUndefined()
    expect(ops[0].payload.priorWriteIds).toContain("write_inflight")
    // Swap, not clobber: the host's own draft survives as a stash sibling.
    expect((await db.composerLoaded.get(aoConversationScope))?.draftId).toBe("draft_stream")
    expect(await db.drafts.get("draft_host")).toBeDefined()
  })

  it("leaves both drafts untouched when the row is checked out under another scope", async () => {
    await db.drafts.bulkAdd([aoDraft("draft_stream", aoHostScope), aoDraft("draft_host", aoConversationScope)])
    await db.composerLoaded.put({ scope: aoConversationScope, workspaceId: aoWorkspaceId, draftId: "draft_host" })
    await seedDraftCacheFromIdb(aoWorkspaceId)

    const { result } = renderHook(() => useAoHarness(aoConversationScope), { wrapper })
    await waitFor(() => expect(result.current.stash.drafts.map((d) => d.id)).toContain("draft_stream"))
    // Another composer checks it out between the pile render and the click.
    await db.composerLoaded.put({ scope: aoHostScope, workspaceId: aoWorkspaceId, draftId: "draft_stream" })

    await act(async () => {
      expect(await result.current.stash.handleRestoreStashed("draft_stream")).toEqual({
        ok: false,
        reason: "checked-out",
      })
    })

    expect((await db.drafts.get("draft_stream"))?.scope).toBe(aoHostScope)
    expect(await upsertOpsFor("draft_stream")).toHaveLength(0)
    expect((await db.composerLoaded.get(aoConversationScope))?.draftId).toBe("draft_host")
  })

  it("leaves both drafts untouched when the row is gone by the time the click lands", async () => {
    await db.drafts.bulkAdd([aoDraft("draft_stream", aoHostScope), aoDraft("draft_host", aoConversationScope)])
    await db.composerLoaded.put({ scope: aoConversationScope, workspaceId: aoWorkspaceId, draftId: "draft_host" })
    await seedDraftCacheFromIdb(aoWorkspaceId)

    const { result } = renderHook(() => useAoHarness(aoConversationScope), { wrapper })
    await waitFor(() => expect(result.current.stash.drafts.map((d) => d.id)).toContain("draft_stream"))
    // Deleted on another device; the pile the user is looking at is a render old.
    await db.drafts.delete("draft_stream")

    await act(async () => {
      expect(await result.current.stash.handleRestoreStashed("draft_stream")).toEqual({
        ok: false,
        reason: "missing",
      })
    })

    expect((await db.composerLoaded.get(aoConversationScope))?.draftId).toBe("draft_host")
    expect(await db.composerTarget.get(aoHostScope)).toBeUndefined()
  })

  // The E2EE item this feature creates: a plaintext board draft targeted from a
  // stream that resolves encrypted is deleted by `purgePlaintextScopeDrafts` on
  // the next composer mount. The pile-time filter can't close it — the resolve
  // can land after the picker rendered.
  it("refuses to adopt once the host stream resolves encrypted", async () => {
    await db.drafts.bulkAdd([aoDraft("draft_conv", aoConversationScope), aoDraft("draft_host", aoHostScope)])
    await db.composerLoaded.put({ scope: aoHostScope, workspaceId: aoWorkspaceId, draftId: "draft_host" })
    await seedDraftCacheFromIdb(aoWorkspaceId)

    const { result } = renderHook(() => useAoHarness(aoHostScope, aoHostScope), { wrapper })
    await waitFor(() => expect(result.current.stash.drafts.map((d) => d.id)).toContain("draft_conv"))
    // Latch the pile the way an open picker does, so the row stays on screen and
    // the ONLY thing that can refuse the restore is the mutation's own re-check.
    act(() => result.current.stash.setPileOpen(true))
    await seedAoStream({ e2eEnabled: true })
    await waitFor(() => expect(result.current.stash.drafts.map((d) => d.id)).toContain("draft_conv"))

    await act(async () => {
      expect(await result.current.stash.handleRestoreStashed("draft_conv")).toEqual({
        ok: false,
        reason: "host-ineligible",
      })
    })

    expect(await db.composerTarget.get(aoHostScope)).toBeUndefined()
    expect(await db.composerLoaded.get(aoConversationScope)).toBeUndefined()
    expect((await db.drafts.get("draft_conv"))?.scope).toBe(aoConversationScope)
  })
})
