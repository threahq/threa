import { describe, it, expect, beforeEach } from "vitest"
import { __resetConversationMessageSnapshots } from "@/stores/conversation-messages-store"
import { waitFor } from "@testing-library/react"
import Dexie from "dexie"
import { db } from "@/db"
import {
  seedBoardPosts,
  mergeBoardConversation,
  putOptimisticBoardPost,
  reconcileOptimisticBoardPost,
  deleteOptimisticBoardPost,
  setBoardRootArchived,
  removeBoardConversationsForStream,
} from "./board-store"
import { seedConversationMessages } from "./conversation-messages-store"
import type { BoardPost, BoardPostMessage, ConversationWithStaleness } from "@threa/types"

const WORKSPACE_ID = "ws_1"

function makeConversation(id: string, lastActivityAt: string): ConversationWithStaleness {
  return {
    id,
    streamId: "stream_1",
    workspaceId: WORKSPACE_ID,
    messageIds: ["m1"],
    participantIds: ["usr_1"],
    secondaryMessageIds: [],
    topicSummary: id,
    summary: null,
    completenessScore: 4,
    confidence: 0.8,
    status: "active",
    parentConversationId: null,
    lastActivityAt,
    createdAt: lastActivityAt,
    updatedAt: lastActivityAt,
    temporalStaleness: 0,
    effectiveCompleteness: 4,
  }
}

function makeMessage(id: string, streamId = "stream_1"): BoardPostMessage {
  return {
    id,
    streamId,
    authorId: "usr_1",
    authorType: "user",
    contentMarkdown: id,
    reactions: {},
    attachments: [],
    linkPreviews: [],
    createdAt: "2026-06-22T12:00:00.000Z",
    editedAt: null,
  }
}

function makePost(id: string, lastActivityAt: string, recentMessages: BoardPostMessage[] = []): BoardPost {
  const conversation = makeConversation(id, lastActivityAt)
  const openingMessage = makeMessage("m1")
  return {
    conversation,
    openingMessage,
    recentMessages,
    totalReplies: recentMessages.length,
    streamIds: [...new Set([conversation.streamId, openingMessage.streamId, ...recentMessages.map((m) => m.streamId)])],
    hasCapturedMemo: false,
    settlingMessageIds: [],
    isMine: false,
  }
}

async function readBoard() {
  return db.conversations
    .where("[workspaceId+_lastActivityMs]")
    .between([WORKSPACE_ID, Dexie.minKey], [WORKSPACE_ID, Dexie.maxKey])
    .reverse()
    .toArray()
}

beforeEach(async () => {
  await db.conversations.clear()
  await db.conversationMessages.clear()
  __resetConversationMessageSnapshots()
})

describe("seedBoardPosts", () => {
  it("orders the feed by last activity, newest first", async () => {
    await seedBoardPosts(WORKSPACE_ID, [
      makePost("conv_old", "2026-06-20T12:00:00.000Z"),
      makePost("conv_new", "2026-06-22T12:00:00.000Z"),
      makePost("conv_mid", "2026-06-21T12:00:00.000Z"),
    ])
    expect((await readBoard()).map((p) => p.id)).toEqual(["conv_new", "conv_mid", "conv_old"])
  })

  it("upserts in place without dropping rows a later page omits", async () => {
    await seedBoardPosts(WORKSPACE_ID, [makePost("conv_a", "2026-06-20T12:00:00.000Z")])
    await seedBoardPosts(WORKSPACE_ID, [makePost("conv_b", "2026-06-21T12:00:00.000Z")])
    expect((await readBoard()).map((p) => p.id)).toEqual(["conv_b", "conv_a"])
  })
})

describe("mergeBoardConversation", () => {
  it("merges the aggregate, re-sorts on activity, and keeps the cached preview of members", async () => {
    await seedBoardPosts(WORKSPACE_ID, [
      makePost("conv_1", "2026-06-20T12:00:00.000Z", [makeMessage("r1")]),
      makePost("conv_2", "2026-06-21T12:00:00.000Z"),
    ])
    const conversation = {
      ...makeConversation("conv_1", "2026-06-22T12:00:00.000Z"),
      messageIds: ["m1", "r1"],
    }
    const merged = await mergeBoardConversation("conv_1", conversation)
    expect(merged).toBe(true)
    const board = await readBoard()
    expect(board.map((p) => p.id)).toEqual(["conv_1", "conv_2"])
    // The event carries the aggregate, not message bodies — a member's cached
    // preview is preserved.
    expect(board[0]?.recentMessages.map((m) => m.id)).toEqual(["r1"])
  })

  it("carries settlingMessageIds from the payload, and keeps the cached set when the event omits it", async () => {
    await seedBoardPosts(WORKSPACE_ID, [makePost("conv_1", "2026-06-20T12:00:00.000Z", [makeMessage("r1")])])
    const conversation = { ...makeConversation("conv_1", "2026-06-22T12:00:00.000Z"), messageIds: ["m1", "r1"] }

    await mergeBoardConversation("conv_1", conversation, ["r1"])
    expect((await db.conversations.get("conv_1"))?.settlingMessageIds).toEqual(["r1"])

    // An emitter that doesn't report the set must not silently clear it.
    await mergeBoardConversation("conv_1", conversation)
    expect((await db.conversations.get("conv_1"))?.settlingMessageIds).toEqual(["r1"])

    await mergeBoardConversation("conv_1", conversation, [])
    expect((await db.conversations.get("conv_1"))?.settlingMessageIds).toEqual([])
  })

  it("drops a re-filed message from the preview when it leaves the membership", async () => {
    await seedBoardPosts(WORKSPACE_ID, [
      makePost("conv_1", "2026-06-20T12:00:00.000Z", [makeMessage("r1"), makeMessage("r2")]),
    ])
    // r2 moved to another conversation (reassignMessage): the aggregate lists
    // m1 + r1 only, so the stale preview row must leave with it.
    const conversation = {
      ...makeConversation("conv_1", "2026-06-22T12:00:00.000Z"),
      messageIds: ["m1", "r1"],
    }
    const merged = await mergeBoardConversation("conv_1", conversation)
    expect(merged).toBe(true)
    expect((await db.conversations.get("conv_1"))?.recentMessages.map((m) => m.id)).toEqual(["r1"])
  })

  it("reports unhandled when the opening itself moved away, so the caller refetches", async () => {
    await seedBoardPosts(WORKSPACE_ID, [makePost("conv_1", "2026-06-20T12:00:00.000Z", [makeMessage("r1")])])
    // The opening (m1) re-filed elsewhere; its replacement's body isn't in the
    // event, so the merge lands what it knows and signals a board-head refetch.
    const conversation = {
      ...makeConversation("conv_1", "2026-06-22T12:00:00.000Z"),
      messageIds: ["r1"],
    }
    const merged = await mergeBoardConversation("conv_1", conversation)
    expect(merged).toBe(false)
    // The row stays put (no vanish-and-return) with the aggregate applied.
    expect((await db.conversations.get("conv_1"))?.conversation.messageIds).toEqual(["r1"])
  })

  it("returns false when the card isn't cached (caller hydrates instead)", async () => {
    const merged = await mergeBoardConversation(
      "conv_absent",
      makeConversation("conv_absent", "2026-06-22T12:00:00.000Z")
    )
    expect(merged).toBe(false)
    expect(await readBoard()).toHaveLength(0)
  })

  it("clears a pending flag when the authoritative echo merges over it", async () => {
    await seedBoardPosts(WORKSPACE_ID, [makePost("conv_1", "2026-06-20T12:00:00.000Z")])
    // A row left pending by an in-flight optimistic write (the reply rides the
    // events rail now; the projection row can still be flagged pending elsewhere).
    const seeded = await db.conversations.get("conv_1")
    await db.conversations.put({ ...seeded!, _status: "pending" })
    await mergeBoardConversation("conv_1", makeConversation("conv_1", "2026-06-21T12:00:05.000Z"))
    expect((await db.conversations.get("conv_1"))?._status).toBeUndefined()
  })

  it("drops the card when the conversation is emptied (its last message threaded off / reassigned)", async () => {
    await seedBoardPosts(WORKSPACE_ID, [
      makePost("conv_1", "2026-06-20T12:00:00.000Z"),
      makePost("conv_2", "2026-06-21T12:00:00.000Z"),
    ])
    const emptied = { ...makeConversation("conv_1", "2026-06-22T12:00:00.000Z"), messageIds: [] }
    const merged = await mergeBoardConversation("conv_1", emptied)
    expect(merged).toBe(true)
    expect((await readBoard()).map((p) => p.id)).toEqual(["conv_2"])
  })

  it("reports an emptied conversation handled even when uncached, so the caller doesn't hydrate it", async () => {
    const emptied = { ...makeConversation("conv_absent", "2026-06-22T12:00:00.000Z"), messageIds: [] }
    const merged = await mergeBoardConversation("conv_absent", emptied)
    expect(merged).toBe(true)
    expect(await readBoard()).toHaveLength(0)
  })
})

describe("putOptimisticBoardPost", () => {
  const input = {
    conversationId: "conv_new",
    messageId: "msg_1",
    streamId: "stream_1",
    authorId: "usr_1",
    contentMarkdown: "just posted",
    rootStreamId: "stream_1",
    rootStreamType: "channel" as const,
    createdAt: "2026-06-22T12:00:00.000Z",
  }

  it("slots a pending card keyed by the real conversation id, renderable from the send alone", async () => {
    await putOptimisticBoardPost(WORKSPACE_ID, input)
    const row = await db.conversations.get("conv_new")
    expect(row).toMatchObject({
      id: "conv_new",
      workspaceId: WORKSPACE_ID,
      _status: "pending",
      openingMessage: expect.objectContaining({ id: "msg_1", contentMarkdown: "just posted", authorId: "usr_1" }),
      isMine: true,
      rootStreamType: "channel",
      settlingMessageIds: [],
    })
    expect(row?.conversation.status).toBe("active")
    expect(row?.conversation.messageIds).toEqual(["msg_1"])
  })

  it("reconciles in place: the conversation echo merges over it and clears the pending flag", async () => {
    await putOptimisticBoardPost(WORKSPACE_ID, input)
    await mergeBoardConversation("conv_new", makeConversation("conv_new", "2026-06-22T12:00:05.000Z"))
    const row = await db.conversations.get("conv_new")
    expect(row?._status).toBeUndefined()
    // Merge keeps the optimistic opening body (the echo carries no message bodies).
    expect(row?.openingMessage?.contentMarkdown).toBe("just posted")
  })

  it("is insert-if-absent: never overwrites an existing row (echo/refetch won, or the stub is already down)", async () => {
    await seedBoardPosts(WORKSPACE_ID, [makePost("conv_new", "2026-06-22T12:00:09.000Z")])
    await putOptimisticBoardPost(WORKSPACE_ID, input)
    const row = await db.conversations.get("conv_new")
    expect(row?._status).toBeUndefined()
    // The existing row's opening (msg m1 from makePost) is untouched, not clobbered
    // with the seed's msg_1.
    expect(row?.openingMessage?.id).toBe("m1")
  })

  it("renders the post's attachments immediately so the thumbnail doesn't pop in on reconcile", async () => {
    await putOptimisticBoardPost(WORKSPACE_ID, {
      ...input,
      attachments: [{ id: "att_1", filename: "shot.png", mimeType: "image/png", sizeBytes: 2048 }],
    })
    const row = await db.conversations.get("conv_new")
    expect(row?.openingMessage?.attachments).toEqual([
      { id: "att_1", filename: "shot.png", mimeType: "image/png", sizeBytes: 2048 },
    ])
  })
})

describe("reconcileOptimisticBoardPost (new-scratchpad drain refine)", () => {
  // The composer-clear stub: keyed by the client-minted id, under the DRAFT stream
  // id, with a client temp message id and client-serialized markdown.
  const stub = {
    conversationId: "conv_new",
    messageId: "temp_scratch",
    streamId: "draft_1",
    authorId: "usr_1",
    contentMarkdown: "client markdown",
    rootStreamId: "draft_1",
    rootStreamType: "scratchpad" as const,
    createdAt: "2026-06-22T12:00:00.000Z",
  }
  // The drain's post-promotion refine: real stream + message ids, server markdown.
  const real = {
    ...stub,
    messageId: "msg_real",
    streamId: "stream_real",
    rootStreamId: "stream_real",
    contentMarkdown: "server markdown",
  }

  it("drain beat the echo (still pending): replaces the stub wholesale with the real ids", async () => {
    await putOptimisticBoardPost(WORKSPACE_ID, stub)
    await reconcileOptimisticBoardPost(WORKSPACE_ID, real)
    const row = await db.conversations.get("conv_new")
    expect(row?._status).toBe("pending")
    expect(row?.conversation.streamId).toBe("stream_real")
    expect(row?.conversation.messageIds).toEqual(["msg_real"])
    expect(row?.openingMessage?.id).toBe("msg_real")
    expect(row?.openingMessage?.contentMarkdown).toBe("server markdown")
    // openingId === messageIds[0] → the card renders the post once, not twice.
    expect(row?.openingMessage?.id).toBe(row?.conversation.messageIds[0])
  })

  it("echo won first: patches the real opening/stream onto the reconciled aggregate without a duplicate", async () => {
    await putOptimisticBoardPost(WORKSPACE_ID, stub)
    // The `conversation:created` echo reconciles the aggregate (real messageIds,
    // clears `_status`) but keeps the stub's stale opening (mergeBoardConversation
    // carries no message bodies).
    await mergeBoardConversation("conv_new", {
      ...makeConversation("conv_new", "2026-06-22T12:00:05.000Z"),
      streamId: "stream_real",
      messageIds: ["msg_real"],
    })
    const afterEcho = await db.conversations.get("conv_new")
    expect(afterEcho?._status).toBeUndefined()
    expect(afterEcho?.openingMessage?.id).toBe("temp_scratch") // stale, mismatched → would render twice
    expect(afterEcho?.openingMessage?.id).not.toBe(afterEcho?.conversation.messageIds[0])

    // The drain's later refine patches the real opening onto the reconciled row.
    await reconcileOptimisticBoardPost(WORKSPACE_ID, real)
    const row = await db.conversations.get("conv_new")
    expect(row?._status).toBeUndefined() // not regressed back to pending
    expect(row?.openingMessage?.id).toBe("msg_real")
    expect(row?.openingMessage?.contentMarkdown).toBe("server markdown")
    expect(row?.conversation.streamId).toBe("stream_real")
    // openingId === messageIds[0] again → no double-render.
    expect(row?.openingMessage?.id).toBe(row?.conversation.messageIds[0])
  })

  it("cancelled mid-send (no row): does NOT resurrect the card", async () => {
    // The user deleted the post while the send was in flight — its card is gone.
    await reconcileOptimisticBoardPost(WORKSPACE_ID, real)
    expect(await db.conversations.get("conv_new")).toBeUndefined()
  })
})

describe("deleteOptimisticBoardPost", () => {
  const input = {
    conversationId: "conv_new",
    messageId: "temp_scratch",
    streamId: "draft_1",
    authorId: "usr_1",
    contentMarkdown: "just posted",
    rootStreamId: "draft_1",
    rootStreamType: "scratchpad" as const,
    createdAt: "2026-06-22T12:00:00.000Z",
  }

  it("drops a pending stub (a cancelled queued post) so it doesn't linger as a phantom", async () => {
    await putOptimisticBoardPost(WORKSPACE_ID, input)
    await deleteOptimisticBoardPost("conv_new")
    expect(await db.conversations.get("conv_new")).toBeUndefined()
  })

  it("leaves a reconciled card alone (a stale cancel must not delete a committed post)", async () => {
    await seedBoardPosts(WORKSPACE_ID, [makePost("conv_new", "2026-06-22T12:00:00.000Z")])
    await deleteOptimisticBoardPost("conv_new")
    expect(await db.conversations.get("conv_new")).toBeDefined()
  })

  it("no-ops when the card doesn't exist", async () => {
    await deleteOptimisticBoardPost("conv_absent")
    expect(await db.conversations.get("conv_absent")).toBeUndefined()
  })
})

/** A post anchored in `streamId` whose effective root is `rootStreamId`. */
function scopedPost(id: string, streamId: string, rootStreamId: string): BoardPost {
  const base = makePost(id, "2026-06-22T12:00:00.000Z")
  return { ...base, conversation: { ...base.conversation, streamId }, rootStreamId }
}

describe("setBoardRootArchived", () => {
  it("flips only the rows of this workspace whose anchor or root is the stream", async () => {
    await seedBoardPosts(WORKSPACE_ID, [
      scopedPost("conv_root", "thread_1", "chan_1"),
      scopedPost("conv_anchor", "chan_1", "chan_1"),
      scopedPost("conv_other", "chan_2", "chan_2"),
    ])
    await seedBoardPosts("ws_2", [scopedPost("conv_ws2", "chan_1", "chan_1")])

    await setBoardRootArchived(WORKSPACE_ID, "chan_1", true)

    expect(await db.conversations.get("conv_root")).toMatchObject({ rootArchived: true })
    expect(await db.conversations.get("conv_anchor")).toMatchObject({ rootArchived: true })
    expect((await db.conversations.get("conv_other"))?.rootArchived).toBeUndefined()
    expect((await db.conversations.get("conv_ws2"))?.rootArchived).toBeUndefined()
  })

  it("clears the flag on unarchive", async () => {
    await seedBoardPosts(WORKSPACE_ID, [scopedPost("conv_root", "thread_1", "chan_1")])
    await setBoardRootArchived(WORKSPACE_ID, "chan_1", true)
    await setBoardRootArchived(WORKSPACE_ID, "chan_1", false)
    expect(await db.conversations.get("conv_root")).toMatchObject({ rootArchived: false })
  })
})

describe("removeBoardConversationsForStream", () => {
  it("deletes only the rows of this workspace the stream contributes", async () => {
    await seedBoardPosts(WORKSPACE_ID, [
      scopedPost("conv_root", "thread_1", "chan_1"),
      scopedPost("conv_anchor", "chan_1", "chan_1"),
      scopedPost("conv_other", "chan_2", "chan_2"),
    ])
    await seedBoardPosts("ws_2", [scopedPost("conv_ws2", "chan_1", "chan_1")])

    await removeBoardConversationsForStream(WORKSPACE_ID, "chan_1")

    expect(await db.conversations.get("conv_root")).toBeUndefined()
    expect(await db.conversations.get("conv_anchor")).toBeUndefined()
    expect(await db.conversations.get("conv_other")).toBeDefined()
    expect(await db.conversations.get("conv_ws2")).toBeDefined()
  })
})

describe("mergeBoardConversation — backfill-store pruning", () => {
  it("drops a re-filed message's backfilled row so the merged view can't resurrect it", async () => {
    await seedBoardPosts(WORKSPACE_ID, [
      makePost("conv_1", "2026-06-20T12:00:00.000Z", [makeMessage("r_old"), makeMessage("r_moved")]),
    ])
    await seedConversationMessages(WORKSPACE_ID, "conv_1", [makeMessage("r_old"), makeMessage("r_moved")])

    await mergeBoardConversation("conv_1", {
      ...makeConversation("conv_1", "2026-06-22T12:00:00.000Z"),
      messageIds: ["m1", "r_old"],
    })

    await waitFor(async () =>
      expect((await db.conversationMessages.toArray()).map((row) => row.messageId)).toEqual(["r_old"])
    )
    const board = await readBoard()
    expect(board[0]?.recentMessages.map((m) => m.id)).toEqual(["r_old"])
  })

  it("clears the backfilled rows of a conversation emptied to zero members", async () => {
    await seedBoardPosts(WORKSPACE_ID, [makePost("conv_1", "2026-06-20T12:00:00.000Z", [makeMessage("r1")])])
    await seedConversationMessages(WORKSPACE_ID, "conv_1", [makeMessage("r1")])

    await mergeBoardConversation("conv_1", {
      ...makeConversation("conv_1", "2026-06-22T12:00:00.000Z"),
      messageIds: [],
    })

    await waitFor(async () => expect(await db.conversationMessages.toArray()).toEqual([]))
  })
})
