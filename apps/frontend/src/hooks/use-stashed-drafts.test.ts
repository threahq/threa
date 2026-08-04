import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { stashLoadedDraft, restoreStashedDraftToComposer, upsertLoadedDraft } from "./use-draft-message"
import type { JSONContent } from "@threa/types"
import { db, type CachedDraft } from "@/db"
import { resetDraftStoreCache } from "@/stores/draft-store"
import { __clearBoardDraftContextRegistry } from "./use-board-draft-context"
import { useStashedDrafts } from "./use-stashed-drafts"

const makeDoc = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : undefined }],
})
const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }

const workspaceId = "ws_123"
const scope = "stream:stream_456"

beforeEach(async () => {
  resetDraftStoreCache()
  await db.drafts.clear()
  await db.composerLoaded.clear()
  await db.pendingOperations.clear()
})

describe("stashLoadedDraft (pointer-move stash)", () => {
  it("detaches the loaded pointer but keeps the row at rest, so it roams as a stash entry", async () => {
    const loaded = await upsertLoadedDraft(workspaceId, scope, { contentJson: makeDoc("draft body"), attachments: [] })
    expect((await db.composerLoaded.get(scope))?.draftId).toBe(loaded.id)

    const stashedId = await stashLoadedDraft(workspaceId, scope)

    expect(stashedId).toBe(loaded.id)
    // Pointer cleared; the row is preserved (not deleted) so it stays a stash entry
    // and keeps roaming — no plaintext snapshot into a new row.
    expect(await db.composerLoaded.get(scope)).toBeUndefined()
    expect(await db.drafts.get(loaded.id)).toBeDefined()
  })

  it("no-ops when nothing is loaded", async () => {
    expect(await stashLoadedDraft(workspaceId, scope)).toBeNull()
  })

  it("keeps a sealed E2E row at rest — never writes plaintext (E2EE-4)", async () => {
    await db.drafts.put({
      id: "draft_sealed",
      workspaceId,
      scope,
      contentJson: EMPTY_DOC,
      attachments: [],
      ciphertext: "ct_sealed",
      envelope: { v: 2 },
      e2eVersion: 2,
      clientUpdatedAt: Date.now(),
    })
    await db.composerLoaded.put({ scope, workspaceId, draftId: "draft_sealed" })

    const stashedId = await stashLoadedDraft(workspaceId, scope)

    expect(stashedId).toBe("draft_sealed")
    const row = await db.drafts.get("draft_sealed")
    expect(row?.ciphertext).toBe("ct_sealed")
    // Still ciphertext-only at rest after stashing.
    expect(row?.contentJson).toEqual(EMPTY_DOC)
    expect(await db.composerLoaded.get(scope)).toBeUndefined()
  })
})

describe("restoreStashedDraftToComposer (pointer-move restore)", () => {
  it("points the scope at the chosen row; the previously-loaded one becomes the stash entry", async () => {
    const first = await upsertLoadedDraft(workspaceId, scope, { contentJson: makeDoc("first"), attachments: [] })
    await stashLoadedDraft(workspaceId, scope)
    const second = await upsertLoadedDraft(workspaceId, scope, { contentJson: makeDoc("second"), attachments: [] })
    expect((await db.composerLoaded.get(scope))?.draftId).toBe(second.id)

    await restoreStashedDraftToComposer(workspaceId, scope, first.id)

    expect((await db.composerLoaded.get(scope))?.draftId).toBe(first.id)
    // Both rows survive (nothing deleted) — `second` is now the stash entry.
    expect(await db.drafts.get(first.id)).toBeDefined()
    expect(await db.drafts.get(second.id)).toBeDefined()
  })
})

const pileWorkspaceId = "ws_pile"

function draftRow(overrides: Partial<CachedDraft> & { id: string; scope: string }): CachedDraft {
  return {
    workspaceId: pileWorkspaceId,
    contentJson: makeDoc(overrides.id),
    attachments: [],
    clientUpdatedAt: 1000,
    baseVersion: 1,
    ...overrides,
  } as CachedDraft
}

function seedStream(id: string, overrides: Record<string, unknown> = {}): Promise<unknown> {
  return db.streams.put({
    id,
    workspaceId: pileWorkspaceId,
    type: "channel",
    visibility: "private",
    rootStreamId: null,
    archivedAt: null,
    ...overrides,
  } as never)
}

/** A cached board post: `messageIds` + the opening id drive `planBoardReply`,
 *  `recentMessages` the recency-biased landing stream. */
function seedConversation(
  id: string,
  streamId: string,
  opts: { messageIds?: string[]; openingMessageId?: string | null; lastActiveStreamId?: string } = {}
): Promise<unknown> {
  const openingMessageId = opts.openingMessageId === undefined ? "msg_1" : opts.openingMessageId
  return db.conversations.put({
    id,
    workspaceId: pileWorkspaceId,
    _lastActivityMs: 1,
    _cachedAt: 1,
    conversation: { id, streamId, messageIds: opts.messageIds ?? ["msg_1", "msg_2"] },
    openingMessage: openingMessageId ? { id: openingMessageId } : null,
    recentMessages: opts.lastActiveStreamId ? [{ streamId: opts.lastActiveStreamId }] : [],
  } as never)
}

async function expectPile(scope: string, ids: string[]) {
  const { result, unmount } = renderHook(() => useStashedDrafts(pileWorkspaceId, scope))
  await waitFor(() => expect(result.current.drafts.map((d) => d.id).sort()).toEqual([...ids].sort()))
  unmount()
}

describe("useStashedDrafts — landing-site membership", () => {
  beforeEach(async () => {
    __clearBoardDraftContextRegistry()
    await db.conversations.clear()
    await db.streams.clear()
  })

  afterEach(() => {
    __clearBoardDraftContextRegistry()
  })

  it("shares a pile both ways between a stream and a conversation that lands flat in it", async () => {
    await seedStream("stream_s")
    await seedConversation("conv_1", "stream_s")
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_stream", scope: "stream:stream_s" }),
      draftRow({ id: "draft_conv", scope: "board:reply:conv_1", clientUpdatedAt: 2000 }),
    ])

    await expectPile("board:reply:conv_1", ["draft_stream", "draft_conv"])
    await expectPile("stream:stream_s", ["draft_stream", "draft_conv"])
  })

  it("keeps a lone channel conversation's reply out of every flat pile (its reply opens a thread)", async () => {
    await seedStream("stream_s")
    await seedConversation("conv_lone", "stream_s", { messageIds: ["msg_1"], openingMessageId: "msg_1" })
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_stream", scope: "stream:stream_s" }),
      draftRow({ id: "draft_lone", scope: "board:reply:conv_lone" }),
      draftRow({ id: "draft_lone_2", scope: "board:reply:conv_lone", clientUpdatedAt: 900 }),
    ])

    await expectPile("stream:stream_s", ["draft_stream"])
    // Its own host lands nested, so its pile stays scope-exact: siblings only.
    await expectPile("board:reply:conv_lone", ["draft_lone", "draft_lone_2"])
  })

  it("never shares a thread, branch or sub-topic draft into another host's pile", async () => {
    await seedStream("stream_s")
    await seedConversation("conv_1", "stream_s")
    await seedConversation("conv_branch", "stream_s")
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_stream", scope: "stream:stream_s" }),
      draftRow({ id: "draft_thread", scope: "thread:msg_9" }),
      draftRow({ id: "draft_branch", scope: "board:branch-reply:conv_branch" }),
      draftRow({ id: "draft_subtopic", scope: "board:subtopic:stream_s:msg_1" }),
    ])

    await expectPile("stream:stream_s", ["draft_stream"])
    await expectPile("board:reply:conv_1", ["draft_stream"])
  })

  it("follows a conversation that moved into a thread: T's pile, not S's", async () => {
    await seedStream("stream_s")
    await seedStream("stream_t", { type: "thread", rootStreamId: "stream_s" })
    await seedConversation("conv_moved", "stream_s", { lastActiveStreamId: "stream_t" })
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_s", scope: "stream:stream_s" }),
      draftRow({ id: "draft_t", scope: "stream:stream_t" }),
      draftRow({ id: "draft_moved", scope: "board:reply:conv_moved" }),
    ])

    await expectPile("stream:stream_s", ["draft_s"])
    await expectPile("stream:stream_t", ["draft_t", "draft_moved"])
  })

  it("excludes a draft checked out into ANY scope's composer on this device", async () => {
    await seedStream("stream_s")
    await seedConversation("conv_1", "stream_s")
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_stream", scope: "stream:stream_s" }),
      draftRow({ id: "draft_conv", scope: "board:reply:conv_1" }),
    ])
    // Live-typed in the timeline composer: the conversation's picker must not
    // offer it, or a move would vacate it under a live editor.
    await db.composerLoaded.put({ scope: "stream:stream_s", workspaceId: pileWorkspaceId, draftId: "draft_stream" })

    await expectPile("board:reply:conv_1", ["draft_conv"])
  })

  it("excludes an empty draft, an archived landing stream, an E2E host, and an uncached conversation", async () => {
    await seedStream("stream_s")
    await seedStream("stream_archived", { archivedAt: "2026-01-01T00:00:00Z" })
    await seedStream("stream_sealed", { e2eEnabled: true })
    await seedConversation("conv_1", "stream_s")
    await seedConversation("conv_archived", "stream_archived")
    await seedConversation("conv_sealed", "stream_sealed")
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_stream", scope: "stream:stream_s" }),
      draftRow({ id: "draft_empty", scope: "stream:stream_s", contentJson: EMPTY_DOC }),
      draftRow({ id: "draft_uncached", scope: "board:reply:conv_missing" }),
      draftRow({ id: "draft_archived", scope: "stream:stream_archived" }),
      draftRow({ id: "draft_archived_conv", scope: "board:reply:conv_archived" }),
      draftRow({ id: "draft_sealed", scope: "stream:stream_sealed" }),
      draftRow({ id: "draft_sealed_conv", scope: "board:reply:conv_sealed" }),
    ])

    await expectPile("stream:stream_s", ["draft_stream"])
    // An archived or sealed host keeps a scope-exact pile — never widened, and
    // its rows never leak into another host's.
    await expectPile("stream:stream_archived", ["draft_archived"])
    await expectPile("stream:stream_sealed", ["draft_sealed"])
    await expectPile("board:reply:conv_sealed", ["draft_sealed_conv"])
  })

  it("resolves a conversation that caches only after the first frame (unknown is never latched)", async () => {
    await seedStream("stream_s")
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_stream", scope: "stream:stream_s" }),
      draftRow({ id: "draft_conv", scope: "board:reply:conv_late" }),
    ])

    const { result } = renderHook(() => useStashedDrafts(pileWorkspaceId, "stream:stream_s"))
    await waitFor(() => expect(result.current.drafts.map((d) => d.id)).toEqual(["draft_stream"]))

    await act(async () => {
      await seedConversation("conv_late", "stream_s")
    })
    await waitFor(() => expect(result.current.drafts.map((d) => d.id).sort()).toEqual(["draft_conv", "draft_stream"]))
  })

  it("reports each row's origin as structured data", async () => {
    await seedStream("stream_s")
    await seedConversation("conv_1", "stream_s")
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_stream", scope: "stream:stream_s" }),
      draftRow({ id: "draft_conv", scope: "board:reply:conv_1" }),
    ])

    const { result } = renderHook(() => useStashedDrafts(pileWorkspaceId, "stream:stream_s"))
    await waitFor(() => expect(result.current.originByDraftId.size).toBe(2))
    expect(Object.fromEntries(result.current.originByDraftId)).toEqual({
      draft_stream: { kind: "stream", streamId: "stream_s" },
      draft_conv: { kind: "conversation", conversationId: "conv_1" },
    })
  })

  it("holds membership while the picker is open, even as the landing site moves", async () => {
    await seedStream("stream_s")
    await seedStream("stream_t", { type: "thread", rootStreamId: "stream_s" })
    await seedConversation("conv_1", "stream_s")
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_stream", scope: "stream:stream_s" }),
      draftRow({ id: "draft_conv", scope: "board:reply:conv_1" }),
    ])

    const { result } = renderHook(() => useStashedDrafts(pileWorkspaceId, "stream:stream_s"))
    await waitFor(() => expect(result.current.drafts).toHaveLength(2))

    act(() => result.current.setPileOpen(true))
    await act(async () => {
      await seedConversation("conv_1", "stream_s", { lastActiveStreamId: "stream_t" })
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(result.current.drafts.map((d) => d.id).sort()).toEqual(["draft_conv", "draft_stream"])

    act(() => result.current.setPileOpen(false))
    await waitFor(() => expect(result.current.drafts.map((d) => d.id)).toEqual(["draft_stream"]))
  })

  it("claimable rows stay this host's own scope even when the pile is wider", async () => {
    await seedStream("stream_s")
    await seedConversation("conv_1", "stream_s")
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_stream", scope: "stream:stream_s" }),
      draftRow({ id: "draft_conv", scope: "board:reply:conv_1" }),
    ])

    const { result } = renderHook(() => useStashedDrafts(pileWorkspaceId, "board:reply:conv_1"))
    await waitFor(() => expect(result.current.drafts).toHaveLength(2))
    expect(result.current.claimableDrafts.map((d) => d.id)).toEqual(["draft_conv"])
  })

  it("never offers or claims a row already checked out by another scope on this device", async () => {
    await seedStream("stream_s")
    await seedConversation("conv_1", "stream_s")
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_shared", scope: "board:reply:conv_1" }),
      draftRow({ id: "draft_sibling", scope: "board:reply:conv_1", clientUpdatedAt: 900 }),
    ])
    // Restored into the timeline composer from the drafts explorer: the row's own
    // scope still says `board:reply:conv_1`, so a scope-exact claimable list would
    // hand the same row to a second composer.
    await db.composerLoaded.put({ scope: "stream:stream_s", workspaceId: pileWorkspaceId, draftId: "draft_shared" })

    const { result } = renderHook(() => useStashedDrafts(pileWorkspaceId, "board:reply:conv_1"))
    await waitFor(() => expect(result.current.claimableDrafts.map((d) => d.id)).toEqual(["draft_sibling"]))
    expect(result.current.drafts.map((d) => d.id)).toEqual(["draft_sibling"])
  })

  // The scope-exact branch deliberately applies NO payload filter. A draft can
  // carry only context refs ("Discuss with Ariadne" seeds exactly that shape:
  // empty body, no attachments), the drafts explorer already skips those, and
  // its own scope's picker is the last surface that can reach it — filtering
  // here would strand the row while it keeps syncing.
  it("keeps a body-less row in its own scope's pile — the explorer already hides it", async () => {
    await seedStream("stream_s")
    await seedConversation("conv_lone", "stream_s", { messageIds: ["msg_1"], openingMessageId: "msg_1" })
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_lone", scope: "board:reply:conv_lone" }),
      draftRow({ id: "draft_lone_empty", scope: "board:reply:conv_lone", contentJson: EMPTY_DOC }),
    ])

    await expectPile("board:reply:conv_lone", ["draft_lone", "draft_lone_empty"])
  })
})
