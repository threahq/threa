import { describe, it, expect, beforeEach } from "vitest"
import Dexie from "dexie"
import { db } from "@/db"
import { seedBoardPosts, mergeBoardConversation } from "./board-store"
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
  it("merges the aggregate, re-sorts on activity, and keeps the cached preview", async () => {
    await seedBoardPosts(WORKSPACE_ID, [
      makePost("conv_1", "2026-06-20T12:00:00.000Z", [makeMessage("r1")]),
      makePost("conv_2", "2026-06-21T12:00:00.000Z"),
    ])
    const merged = await mergeBoardConversation("conv_1", makeConversation("conv_1", "2026-06-22T12:00:00.000Z"))
    expect(merged).toBe(true)
    const board = await readBoard()
    expect(board.map((p) => p.id)).toEqual(["conv_1", "conv_2"])
    // The event carries the aggregate, not message bodies — preview is preserved.
    expect(board[0]?.recentMessages.map((m) => m.id)).toEqual(["r1"])
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
