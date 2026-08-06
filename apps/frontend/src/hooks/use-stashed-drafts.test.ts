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
    const row = await db.drafts.get(loaded.id)
    expect(row).toBeDefined()
    // Durable stash (chunk 4): the marker is set WITHOUT bumping recency, and a
    // push is enqueued so it roams to every device.
    expect(row?.stashedAt).toEqual(expect.any(Number))
    expect(row?.clientUpdatedAt).toBe(loaded.clientUpdatedAt)
  })

  // The setup above coalesces onto the create's own op, which made an "op
  // exists" assertion vacuous (it existed before the stash). This seeds a
  // CLEAN, fully-synced row — baseVersion set, queue empty — so the op can only
  // come from the stash itself; without the enqueue the marker never leaves
  // this device.
  it("enqueues the marker push even for a clean, already-synced row", async () => {
    await db.drafts.put({
      id: "draft_clean",
      workspaceId,
      scope,
      contentJson: makeDoc("synced body"),
      attachments: [],
      baseVersion: 3,
      clientUpdatedAt: 1000,
    })
    await db.composerLoaded.put({ scope, workspaceId, draftId: "draft_clean" })
    expect(await db.pendingOperations.count()).toBe(0)

    await stashLoadedDraft(workspaceId, scope)

    expect((await db.drafts.get("draft_clean"))?.stashedAt).toEqual(expect.any(Number))
    const ops = await db.pendingOperations.where("type").equals("upsert_draft").toArray()
    expect(ops.some((op) => (op.payload as { draftId?: string }).draftId === "draft_clean")).toBe(true)
  })

  it("restore enqueues the un-stash push for a clean, already-synced stashed row", async () => {
    await db.drafts.put({
      id: "draft_clean_stashed",
      workspaceId,
      scope,
      contentJson: makeDoc("synced body"),
      attachments: [],
      baseVersion: 5,
      clientUpdatedAt: 1000,
      stashedAt: 900,
    })
    expect(await db.pendingOperations.count()).toBe(0)

    await restoreStashedDraftToComposer(workspaceId, scope, "draft_clean_stashed")

    expect((await db.drafts.get("draft_clean_stashed"))?.stashedAt).toBeNull()
    const ops = await db.pendingOperations.where("type").equals("upsert_draft").toArray()
    expect(ops.some((op) => (op.payload as { draftId?: string }).draftId === "draft_clean_stashed")).toBe(true)
  })

  it("a MECHANICAL detach (putAway: false) clears the pointer without the durable marker", async () => {
    const loaded = await upsertLoadedDraft(workspaceId, scope, { contentJson: makeDoc("armed reply"), attachments: [] })

    const stashedId = await stashLoadedDraft(workspaceId, scope, { putAway: false })

    expect(stashedId).toBe(loaded.id)
    expect(await db.composerLoaded.get(scope)).toBeUndefined()
    // No marker: a disarm is "stop replying here", not "put the draft away" —
    // the board button and auto-restore must keep advertising it everywhere.
    expect((await db.drafts.get(loaded.id))?.stashedAt ?? null).toBeNull()
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
    // Restoring UN-stashes: the durable marker set by the stash clears and the
    // clear is pushed (chunk 4).
    expect((await db.drafts.get(first.id))?.stashedAt).toBeNull()
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
  opts: {
    messageIds?: string[]
    openingMessageId?: string | null
    lastActiveStreamId?: string
    topicSummary?: string
  } = {}
): Promise<unknown> {
  const openingMessageId = opts.openingMessageId === undefined ? "msg_1" : opts.openingMessageId
  return db.conversations.put({
    id,
    workspaceId: pileWorkspaceId,
    _lastActivityMs: 1,
    _cachedAt: 1,
    conversation: { id, streamId, messageIds: opts.messageIds ?? ["msg_1", "msg_2"], topicSummary: opts.topicSummary },
    openingMessage: openingMessageId ? { id: openingMessageId } : null,
    recentMessages: opts.lastActiveStreamId ? [{ streamId: opts.lastActiveStreamId }] : [],
  } as never)
}

/** Seed a `message_created` event so a `thread:<anchor>` draft resolves a host stream. */
function seedThreadAnchor(messageId: string, streamId: string): Promise<unknown> {
  return db.events.put({
    id: `evt_${messageId}`,
    workspaceId: pileWorkspaceId,
    streamId,
    eventType: "message_created",
    payload: { messageId },
    sequence: "1",
    _sequenceNum: 1,
    actorId: null,
    actorType: null,
    createdAt: new Date(1000).toISOString(),
  } as never)
}

async function expectPile(scope: string, ids: string[]) {
  const { result, unmount } = renderHook(() => useStashedDrafts(pileWorkspaceId, scope))
  await waitFor(() => expect(result.current.drafts.map((d) => d.id).sort()).toEqual([...ids].sort()))
  unmount()
}

/** A conversation-backfill row: the point-read route from a message to its conversation. */
function seedConversationMessage(messageId: string, conversationId: string, streamId: string): Promise<unknown> {
  return db.conversationMessages.put({
    messageId,
    id: messageId,
    conversationId,
    workspaceId: pileWorkspaceId,
    streamId,
    _cachedAt: 1,
  } as never)
}

describe("useStashedDrafts — pile membership", () => {
  beforeEach(async () => {
    __clearBoardDraftContextRegistry()
    await db.conversations.clear()
    await db.conversationMessages.clear()
    await db.streams.clear()
    await db.events.clear()
  })

  afterEach(() => {
    __clearBoardDraftContextRegistry()
  })

  it("shares a pile both ways between a stream and a conversation anchored in it", async () => {
    await seedStream("stream_s")
    await seedConversation("conv_1", "stream_s")
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_stream", scope: "stream:stream_s" }),
      draftRow({ id: "draft_conv", scope: "board:reply:conv_1", clientUpdatedAt: 2000 }),
    ])

    await expectPile("board:reply:conv_1", ["draft_stream", "draft_conv"])
    await expectPile("stream:stream_s", ["draft_stream", "draft_conv"])
  })

  // Replying to a conversation is a top-level act in its stream, so a lone
  // conversation's reply — which would convert its opener into a thread — is
  // still something the user might have said in the channel instead.
  it("includes a lone channel conversation's reply in the channel's pile, tiered borrowed", async () => {
    await seedStream("stream_s")
    await seedConversation("conv_lone", "stream_s", { messageIds: ["msg_1"], openingMessageId: "msg_1" })
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_stream", scope: "stream:stream_s" }),
      draftRow({ id: "draft_lone", scope: "board:reply:conv_lone" }),
    ])

    const { result } = renderHook(() => useStashedDrafts(pileWorkspaceId, "stream:stream_s"))
    await waitFor(() => expect(result.current.drafts.map((d) => d.id)).toEqual(["draft_stream", "draft_lone"]))
    expect(result.current.originByDraftId.get("draft_lone")).toEqual({
      kind: "conversation",
      conversationId: "conv_lone",
      tier: "borrowed",
      checkedOutElsewhere: false,
      openHref: null,
      openConversationId: null,
      title: null,
      // No topic summary yet — the label falls back to this stream's name rather
      // than a generic phrase, the same rung the drafts explorer uses.
      anchorStreamId: "stream_s",
    })
  })

  it("keeps a conversation that drifted into a thread in the channel's pile", async () => {
    await seedStream("stream_s")
    await seedStream("stream_t", { type: "thread", rootStreamId: "stream_s" })
    await seedConversation("conv_moved", "stream_s", { lastActiveStreamId: "stream_t" })
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_s", scope: "stream:stream_s" }),
      draftRow({ id: "draft_moved", scope: "board:reply:conv_moved" }),
    ])

    await expectPile("stream:stream_s", ["draft_s", "draft_moved"])
  })

  it("reaches a top-level draft downward into a thread composer's pile", async () => {
    await seedStream("stream_s")
    await seedThreadAnchor("msg_9", "stream_s")
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_stream", scope: "stream:stream_s" }),
      draftRow({ id: "draft_thread", scope: "thread:msg_9" }),
    ])

    await expectPile("thread:msg_9", ["draft_thread", "draft_stream"])
  })

  // The one exclusion the top-level host route does NOT cover: no conversation
  // owns this thread, so the draft is only reachable where it was written.
  it("keeps a draft in a conversation-less thread in its own pile only", async () => {
    await seedStream("stream_s")
    await seedThreadAnchor("msg_9", "stream_s")
    await seedConversation("conv_1", "stream_s", { messageIds: ["msg_1"] })
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_stream", scope: "stream:stream_s" }),
      draftRow({ id: "draft_thread", scope: "thread:msg_9" }),
      draftRow({ id: "draft_conv", scope: "board:reply:conv_1" }),
    ])

    await expectPile("stream:stream_s", ["draft_stream", "draft_conv"])
    await expectPile("board:reply:conv_1", ["draft_conv", "draft_stream"])
  })

  it("does not match two unresolvable conversations to each other", async () => {
    await seedStream("stream_s")
    await seedThreadAnchor("msg_a", "stream_s")
    await seedThreadAnchor("msg_b", "stream_s")
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_a", scope: "thread:msg_a" }),
      draftRow({ id: "draft_b", scope: "thread:msg_b" }),
      // The control row: top level, so it reaches BOTH threads (R2). Without it
      // an all-own pile would satisfy the assertion on its very first frame,
      // before the shared context has resolved anything.
      draftRow({ id: "draft_top", scope: "stream:stream_s" }),
    ])

    await expectPile("thread:msg_a", ["draft_a", "draft_top"])
    await expectPile("thread:msg_b", ["draft_b", "draft_top"])
  })

  it("puts a thread stream's draft in its conversation's pile and at top level, never in another conversation's", async () => {
    await seedStream("stream_s")
    await seedStream("stream_tc", { type: "thread", rootStreamId: "stream_s", parentAnchorId: "msg_c" })
    await seedThreadAnchor("msg_c", "stream_s")
    await seedConversation("conv_c", "stream_s", { messageIds: ["msg_c"] })
    await seedConversation("conv_d", "stream_s", { messageIds: ["msg_d"] })
    await seedConversationMessage("msg_c", "conv_c", "stream_s")
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_in_c_thread", scope: "stream:stream_tc" }),
      // A top-level control row: it belongs in every pile here, so D's assertion
      // waits for a settled pile instead of passing on the empty first frame.
      draftRow({ id: "draft_top", scope: "stream:stream_s" }),
    ])

    await expectPile("board:reply:conv_c", ["draft_in_c_thread", "draft_top"])
    await expectPile("stream:stream_tc", ["draft_in_c_thread", "draft_top"])
    await expectPile("stream:stream_s", ["draft_in_c_thread", "draft_top"])
    await expectPile("board:reply:conv_d", ["draft_top"])
  })

  it("puts a sub-topic fork off a conversation's message in that conversation's pile, never in another's", async () => {
    await seedStream("stream_s")
    await seedConversation("conv_c", "stream_s", { messageIds: ["msg_c"] })
    await seedConversation("conv_d", "stream_s", { messageIds: ["msg_d"] })
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_fork", scope: "board:subtopic:stream_s:msg_c" }),
      draftRow({ id: "draft_top", scope: "stream:stream_s" }),
    ])

    await expectPile("board:reply:conv_c", ["draft_fork", "draft_top"])
    await expectPile("stream:stream_s", ["draft_fork", "draft_top"])
    await expectPile("board:reply:conv_d", ["draft_top"])
  })

  it("puts a branch reply under a conversation in that conversation's pile", async () => {
    await seedStream("stream_s")
    await seedStream("stream_tb", { type: "thread", rootStreamId: "stream_s", parentAnchorId: "msg_c" })
    await seedConversation("conv_c", "stream_s", { messageIds: ["msg_c"] })
    await seedConversation("conv_branch", "stream_tb", { messageIds: ["msg_branch"] })
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_branch", scope: "board:branch-reply:conv_branch" }),
      draftRow({ id: "draft_top", scope: "stream:stream_s" }),
    ])

    await expectPile("board:reply:conv_c", ["draft_branch", "draft_top"])
  })

  it("keeps a draft under a different root stream out of the pile", async () => {
    await seedStream("stream_s")
    await seedStream("stream_other")
    await seedStream("stream_other_t", { type: "thread", rootStreamId: "stream_other" })
    await seedConversation("conv_other", "stream_other")
    await seedThreadAnchor("msg_other", "stream_other")
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_stream", scope: "stream:stream_s" }),
      draftRow({ id: "draft_other", scope: "stream:stream_other" }),
      draftRow({ id: "draft_other_thread_stream", scope: "stream:stream_other_t" }),
      draftRow({ id: "draft_other_conv", scope: "board:reply:conv_other" }),
      draftRow({ id: "draft_other_anchor", scope: "thread:msg_other" }),
      draftRow({ id: "draft_other_subtopic", scope: "board:subtopic:stream_other:msg_z" }),
    ])

    await expectPile("stream:stream_s", ["draft_stream"])
  })

  it("orders own rows before borrowed rows, each group newest first", async () => {
    await seedStream("stream_s")
    await seedConversation("conv_1", "stream_s")
    await db.drafts.bulkAdd([
      draftRow({ id: "own_old", scope: "stream:stream_s", clientUpdatedAt: 100 }),
      draftRow({ id: "own_new", scope: "stream:stream_s", clientUpdatedAt: 400 }),
      draftRow({ id: "borrowed_old", scope: "board:reply:conv_1", clientUpdatedAt: 200 }),
      draftRow({ id: "borrowed_new", scope: "board:reply:conv_1", clientUpdatedAt: 500 }),
    ])

    const { result } = renderHook(() => useStashedDrafts(pileWorkspaceId, "stream:stream_s"))
    await waitFor(() =>
      expect(result.current.drafts.map((d) => d.id)).toEqual(["own_new", "own_old", "borrowed_new", "borrowed_old"])
    )
    expect([...result.current.originByDraftId.values()].map((origin) => origin.tier)).toEqual([
      "own",
      "own",
      "borrowed",
      "borrowed",
    ])
  })

  it("offers a draft checked out under ANOTHER scope, marked checkedOutElsewhere; hides only this host's own loaded one", async () => {
    await seedStream("stream_s")
    await seedConversation("conv_1", "stream_s")
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_stream", scope: "stream:stream_s" }),
      draftRow({ id: "draft_conv", scope: "board:reply:conv_1" }),
    ])
    // Loaded under the timeline scope — v1 hid this row from every other pile,
    // which (pointers never detaching on navigation) meant nothing ever shared
    // without an explicit stash. v2 offers it; a tap takes it over (chunk 2).
    await db.composerLoaded.put({ scope: "stream:stream_s", workspaceId: pileWorkspaceId, draftId: "draft_stream" })

    const { result, unmount } = renderHook(() => useStashedDrafts(pileWorkspaceId, "board:reply:conv_1"))
    await waitFor(() => expect(result.current.drafts.map((d) => d.id).sort()).toEqual(["draft_conv", "draft_stream"]))
    expect(result.current.originByDraftId.get("draft_stream")?.checkedOutElsewhere).toBe(true)
    expect(result.current.originByDraftId.get("draft_conv")?.checkedOutElsewhere).toBe(false)
    // The deep-link claim set includes the loaded-elsewhere row too (take-over).
    expect(result.current.claimableDrafts.map((d) => d.id)).toEqual(["draft_conv"])
    unmount()

    // Control: the host whose OWN composer holds the draft does not see it in
    // its pile (it is already on screen) — the exclusion that remains.
    const host = renderHook(() => useStashedDrafts(pileWorkspaceId, "stream:stream_s"))
    await waitFor(() => expect(host.result.current.drafts.map((d) => d.id)).toEqual(["draft_conv"]))
    expect(host.result.current.claimableDrafts.map((d) => d.id)).toEqual([])
    host.unmount()
  })

  it("a stream draft with a live pointer appears in a same-root conversation pile without any stash step", async () => {
    await seedStream("stream_s")
    await seedConversation("conv_1", "stream_s")
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_typed", scope: "stream:stream_s" }),
      // Control row proving the pile is not just "everything": a draft under a
      // different root stays out even while the widened rule admits the typed one.
      draftRow({ id: "draft_other_root", scope: "stream:stream_other" }),
    ])
    await seedStream("stream_other")
    await db.composerLoaded.put({ scope: "stream:stream_s", workspaceId: pileWorkspaceId, draftId: "draft_typed" })

    await expectPile("board:reply:conv_1", ["draft_typed"])
  })

  it("excludes an empty borrowed draft, an archived home, an E2E host, and an uncached conversation", async () => {
    await seedStream("stream_s")
    await seedStream("stream_archived", { archivedAt: "2026-01-01T00:00:00Z" })
    await seedStream("stream_sealed", { e2eEnabled: true })
    await seedConversation("conv_1", "stream_s")
    await seedConversation("conv_archived", "stream_archived")
    await seedConversation("conv_sealed", "stream_sealed")
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_stream", scope: "stream:stream_s" }),
      draftRow({ id: "draft_empty", scope: "board:reply:conv_1", contentJson: EMPTY_DOC }),
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

  it("reports each row's origin and tier as structured data", async () => {
    await seedStream("stream_s")
    await seedConversation("conv_1", "stream_s", { messageIds: ["msg_1", "msg_9"], topicSummary: "Pizza plans" })
    await seedThreadAnchor("msg_9", "stream_s")
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_stream", scope: "stream:stream_s" }),
      draftRow({ id: "draft_conv", scope: "board:reply:conv_1" }),
      draftRow({ id: "draft_thread", scope: "thread:msg_9" }),
      draftRow({ id: "draft_subtopic", scope: "board:subtopic:stream_s:msg_1" }),
    ])

    const { result } = renderHook(() => useStashedDrafts(pileWorkspaceId, "stream:stream_s"))
    await waitFor(() => expect(result.current.originByDraftId.size).toBe(4))
    expect(Object.fromEntries(result.current.originByDraftId)).toEqual({
      draft_stream: {
        kind: "stream",
        streamId: "stream_s",
        tier: "own",
        checkedOutElsewhere: false,
        openHref: null,
        openConversationId: null,
        title: null,
        anchorStreamId: "stream_s",
      },
      draft_conv: {
        kind: "conversation",
        conversationId: "conv_1",
        tier: "borrowed",
        checkedOutElsewhere: false,
        openHref: null,
        openConversationId: null,
        title: "Pizza plans",
        anchorStreamId: "stream_s",
      },
      draft_thread: {
        kind: "thread",
        anchorId: "msg_9",
        streamId: "stream_s",
        tier: "borrowed",
        checkedOutElsewhere: false,
        openHref: null,
        openConversationId: null,
        title: null,
        anchorStreamId: "stream_s",
      },
      draft_subtopic: {
        kind: "subtopic",
        streamId: "stream_s",
        messageId: "msg_1",
        anchorStreamId: "stream_s",
        tier: "borrowed",
        checkedOutElsewhere: false,
        openHref: null,
        openConversationId: null,
        title: "Pizza plans",
      },
    })
  })

  it("holds membership while the picker is open, even as the home stream moves", async () => {
    await seedStream("stream_s")
    await seedStream("stream_other")
    await seedConversation("conv_1", "stream_s")
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_stream", scope: "stream:stream_s" }),
      draftRow({ id: "draft_conv", scope: "board:reply:conv_1" }),
    ])

    const { result } = renderHook(() => useStashedDrafts(pileWorkspaceId, "stream:stream_s"))
    await waitFor(() => expect(result.current.drafts).toHaveLength(2))

    act(() => result.current.setPileOpen(true))
    await act(async () => {
      await seedConversation("conv_1", "stream_other")
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

  // Every `composerLoaded` writer keeps pointer-scope == row-scope (adopt checks
  // a row out under its OWN scope; move rewrites the scope first), so "checked
  // out elsewhere" always means: a borrowed row loaded in its own composer on
  // another surface. That also means a host's claim set never meets a foreign
  // pointer on its own rows — dropping the old checked-out-anywhere claim filter
  // is behavior-preserving, and the exclusion that remains (the host's own
  // loaded draft) is asserted here with live rows on both sides.
  it("offers a borrowed row loaded in its own composer elsewhere; a host never claims its own loaded draft", async () => {
    await seedStream("stream_s")
    await seedConversation("conv_1", "stream_s")
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_shared", scope: "board:reply:conv_1" }),
      draftRow({ id: "draft_sibling", scope: "board:reply:conv_1", clientUpdatedAt: 900 }),
    ])
    // The conversation's docked composer holds draft_shared (reachable shape:
    // pointer under the row's own scope). v1 hid it from the stream's pile; v2
    // offers it there — a tap takes it over (chunk 2).
    await db.composerLoaded.put({
      scope: "board:reply:conv_1",
      workspaceId: pileWorkspaceId,
      draftId: "draft_shared",
    })

    const stream = renderHook(() => useStashedDrafts(pileWorkspaceId, "stream:stream_s"))
    await waitFor(() =>
      expect(stream.result.current.drafts.map((d) => d.id).sort()).toEqual(["draft_shared", "draft_sibling"])
    )
    expect(stream.result.current.originByDraftId.get("draft_shared")?.checkedOutElsewhere).toBe(true)
    expect(stream.result.current.originByDraftId.get("draft_sibling")?.checkedOutElsewhere).toBe(false)
    stream.unmount()

    // The conversation host itself: its loaded draft is on screen, so neither
    // pile nor claim set offers it; the detached sibling stays claimable.
    const conv = renderHook(() => useStashedDrafts(pileWorkspaceId, "board:reply:conv_1"))
    await waitFor(() => expect(conv.result.current.claimableDrafts.map((d) => d.id)).toEqual(["draft_sibling"]))
    expect(conv.result.current.drafts.map((d) => d.id)).toEqual(["draft_sibling"])
    conv.unmount()
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

  // A `thread:` HOST resolves its own anchor even with no thread-scoped draft in
  // the workspace: the anchor set the shared context is keyed on includes the
  // host's, not just the drafts'. Without that the draft-thread panel — whose own
  // row does not exist until the debounce fires — opens onto an empty pile.
  it("resolves a thread host's home with no thread-scoped draft anywhere", async () => {
    await seedStream("stream_s")
    await seedThreadAnchor("msg_9", "stream_s")
    await db.drafts.add(draftRow({ id: "draft_stream", scope: "stream:stream_s" }))

    await expectPile("thread:msg_9", ["draft_stream"])
    expect(await db.drafts.where("scope").startsWith("thread:").count()).toBe(0)
  })
})

describe("useStashedDrafts — the worked example: two conversations in one channel", () => {
  beforeEach(async () => {
    __clearBoardDraftContextRegistry()
    await db.conversations.clear()
    await db.conversationMessages.clear()
    await db.streams.clear()
    await db.events.clear()

    // stream_s holds two root messages, each the opener of its own conversation.
    // A has a thread (four replies, so a real thread stream); B has none, only a
    // draft reply in a draft thread.
    await seedStream("stream_s")
    await seedStream("stream_ta", { type: "thread", rootStreamId: "stream_s", parentAnchorId: "msg_a1" })
    await seedThreadAnchor("msg_a1", "stream_s")
    await seedThreadAnchor("msg_b1", "stream_s")
    await seedConversation("conv_a", "stream_s", { messageIds: ["msg_a1"], openingMessageId: "msg_a1" })
    await seedConversation("conv_b", "stream_s", { messageIds: ["msg_b1"], openingMessageId: "msg_b1" })
    await seedConversationMessage("msg_a1", "conv_a", "stream_s")
    await seedConversationMessage("msg_b1", "conv_b", "stream_s")

    await db.drafts.bulkAdd([
      draftRow({ id: "draft_b_thread", scope: "thread:msg_b1" }),
      draftRow({ id: "draft_a_thread", scope: "stream:stream_ta" }),
      draftRow({ id: "draft_top", scope: "stream:stream_s" }),
    ])
  })

  afterEach(() => {
    __clearBoardDraftContextRegistry()
  })

  it("continues B's draft-thread reply from B's conversation view and from the draft thread itself", async () => {
    await expectPile("board:reply:conv_b", ["draft_b_thread", "draft_top"])
    await expectPile("thread:msg_b1", ["draft_b_thread", "draft_top"])
  })

  it("continues A's thread draft from A's conversation view", async () => {
    await expectPile("board:reply:conv_a", ["draft_a_thread", "draft_top"])
  })

  it("shows a top-level draft in both conversation views", async () => {
    const { result } = renderHook(() => useStashedDrafts(pileWorkspaceId, "board:reply:conv_a"))
    await waitFor(() => expect(result.current.drafts.map((d) => d.id)).toContain("draft_top"))
    await expectPile("board:reply:conv_b", ["draft_b_thread", "draft_top"])
  })

  it("shows either conversation's draft in the top-level stream composer", async () => {
    await expectPile("stream:stream_s", ["draft_top", "draft_a_thread", "draft_b_thread"])
  })

  it("keeps each conversation's draft out of the other conversation's pile", async () => {
    const { result } = renderHook(() => useStashedDrafts(pileWorkspaceId, "board:reply:conv_a"))
    await waitFor(() => expect(result.current.drafts.map((d) => d.id)).toContain("draft_a_thread"))
    expect(result.current.drafts.map((d) => d.id)).not.toContain("draft_b_thread")
  })
})

describe("restoreStashedDraftToComposer — id validated in the txn (INV-20)", () => {
  it("follows a re-key that landed mid-restore instead of pointing at the retired id", async () => {
    const { migrateLocalDraftId } = await import("@/sync/draft-sync")
    const { resetDraftResolutionGuard } = await import("@/sync/draft-resolution-guard")
    resetDraftResolutionGuard()
    const first = await upsertLoadedDraft(workspaceId, scope, { contentJson: makeDoc("body"), attachments: [] })
    await stashLoadedDraft(workspaceId, scope)
    // A split ack re-keys the row between the caller's read and the restore txn.
    const live = await db.drafts.get(first.id)
    await migrateLocalDraftId(workspaceId, first.id, { ...live!, id: "draft_rekeyed", baseVersion: 4 })

    expect(await restoreStashedDraftToComposer(workspaceId, scope, first.id)).toBe(true)

    // The pointer follows the migration — never the retired id, which would
    // render an empty composer over an orphaned row.
    expect((await db.composerLoaded.get(scope))?.draftId).toBe("draft_rekeyed")
    expect(await db.drafts.get(first.id)).toBeUndefined()
  })

  it("returns false for a row that is genuinely gone, and points at nothing", async () => {
    expect(await restoreStashedDraftToComposer(workspaceId, scope, "draft_never")).toBe(false)
    expect(await db.composerLoaded.get(scope)).toBeUndefined()
  })
})

describe("navigate rows (openHref)", () => {
  beforeEach(async () => {
    __clearBoardDraftContextRegistry()
    await db.conversations.clear()
    await db.conversationMessages.clear()
    await db.streams.clear()
    await db.events.clear()
  })

  afterEach(() => {
    __clearBoardDraftContextRegistry()
  })

  it("gives a branch row a panel deep link to its PARENT conversation, with the stash param", async () => {
    await seedStream("stream_s")
    await seedStream("stream_tb", { type: "thread", rootStreamId: "stream_s", parentAnchorId: "msg_c" })
    await seedConversation("conv_c", "stream_s", { messageIds: ["msg_c"] })
    await seedConversation("conv_branch", "stream_tb", { messageIds: ["msg_branch"] })
    await db.drafts.bulkAdd([
      draftRow({ id: "draft_branch", scope: "board:branch-reply:conv_branch" }),
      // Control: an ordinary conversation row (no mounted composer) navigates
      // nowhere — it restores in place.
      draftRow({ id: "draft_conv", scope: "board:reply:conv_c" }),
    ])

    const { result, unmount } = renderHook(() => useStashedDrafts(pileWorkspaceId, "board:reply:conv_c"))
    await waitFor(() =>
      expect(result.current.originByDraftId.get("draft_branch")?.openHref).toBe(
        `/w/${pileWorkspaceId}/s/stream_s?panel=${encodeURIComponent("conv:conv_c")}&stash=draft_branch`
      )
    )
    expect(result.current.originByDraftId.get("draft_conv")?.openHref ?? null).toBeNull()
    unmount()
  })

  it("an OWN branch row never navigates — the branch composer restores its own stash in place", async () => {
    await seedStream("stream_s")
    await seedStream("stream_tb", { type: "thread", rootStreamId: "stream_s", parentAnchorId: "msg_c" })
    await seedConversation("conv_c", "stream_s", { messageIds: ["msg_c"] })
    await seedConversation("conv_branch", "stream_tb", { messageIds: ["msg_branch"] })
    await db.drafts.put(draftRow({ id: "draft_own_branch", scope: "board:branch-reply:conv_branch" }))

    // Host IS the branch composer: its own stashed row must be a plain
    // same-scope restore (pointer move), not a navigation away from the card.
    const { result, unmount } = renderHook(() => useStashedDrafts(pileWorkspaceId, "board:branch-reply:conv_branch"))
    await waitFor(() => expect(result.current.drafts.map((d) => d.id)).toContain("draft_own_branch"))
    expect(result.current.originByDraftId.get("draft_own_branch")?.openHref ?? null).toBeNull()
    expect(result.current.originByDraftId.get("draft_own_branch")?.tier).toBe("own")
    unmount()
  })
})
