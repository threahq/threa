import { describe, it, expect, beforeEach } from "vitest"
import Dexie from "dexie"
import { db } from "@/db"
import { seedBoardPosts, mergeBoardConversation, optimisticBoardReply } from "./board-store"
import type { BoardPost, BoardPostMessage, ConversationWithStaleness } from "@threa/types"

const WORKSPACE_ID = "ws_1"

function makeConversation(
  id: string,
  lastActivityAt: string,
  messageIds: string[] = ["m1"]
): ConversationWithStaleness {
  return {
    id,
    streamId: "stream_1",
    workspaceId: WORKSPACE_ID,
    messageIds,
    participantIds: ["usr_1"],
    secondaryMessageIds: [],
    topicSummary: id,
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

function makeMessage(id: string, createdAt = "2026-06-22T12:00:00.000Z"): BoardPostMessage {
  return {
    id,
    authorId: "usr_1",
    authorType: "user",
    contentMarkdown: id,
    reactions: {},
    attachments: [],
    linkPreviews: [],
    createdAt,
  }
}

function makePost(id: string, lastActivityAt: string, recentMessages: BoardPostMessage[] = []): BoardPost {
  return {
    conversation: makeConversation(id, lastActivityAt, ["m1", ...recentMessages.map((m) => m.id)]),
    openingMessage: makeMessage("m1"),
    recentMessages,
    totalReplies: recentMessages.length,
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
    const merged = await mergeBoardConversation(
      "conv_1",
      makeConversation("conv_1", "2026-06-22T12:00:00.000Z", ["m1", "r1"])
    )
    expect(merged).toBe(true)
    const board = await readBoard()
    expect(board.map((p) => p.id)).toEqual(["conv_1", "conv_2"])
    // No triggering body on this event — the existing preview is preserved.
    expect(board[0]?.recentMessages.map((m) => m.id)).toEqual(["r1"])
  })

  it("appends the triggering message body so a new reply shows in place", async () => {
    await seedBoardPosts(WORKSPACE_ID, [makePost("conv_1", "2026-06-20T12:00:00.000Z", [makeMessage("r1")])])
    await mergeBoardConversation(
      "conv_1",
      makeConversation("conv_1", "2026-06-22T12:00:00.000Z", ["m1", "r1", "r2"]),
      makeMessage("r2", "2026-06-22T12:00:00.000Z")
    )
    const row = await db.conversations.get("conv_1")
    expect(row?.recentMessages.map((m) => m.id)).toEqual(["r1", "r2"])
    expect(row?.totalReplies).toBe(2)
  })

  it("dedups the triggering body against an optimistic write or a re-echo", async () => {
    await seedBoardPosts(WORKSPACE_ID, [makePost("conv_1", "2026-06-20T12:00:00.000Z", [makeMessage("r1")])])
    const echo = () =>
      mergeBoardConversation(
        "conv_1",
        makeConversation("conv_1", "2026-06-22T12:00:00.000Z", ["m1", "r1"]),
        makeMessage("r1", "2026-06-22T12:00:00.000Z")
      )
    await echo()
    await echo()
    const row = await db.conversations.get("conv_1")
    expect(row?.recentMessages.map((m) => m.id)).toEqual(["r1"])
    expect(row?.totalReplies).toBe(1)
  })

  it("orders the appended body by time and caps the preview at three", async () => {
    await seedBoardPosts(WORKSPACE_ID, [
      makePost("conv_1", "2026-06-20T12:00:00.000Z", [
        makeMessage("r1", "2026-06-22T12:00:01.000Z"),
        makeMessage("r2", "2026-06-22T12:00:02.000Z"),
        makeMessage("r3", "2026-06-22T12:00:03.000Z"),
      ]),
    ])
    await mergeBoardConversation(
      "conv_1",
      makeConversation("conv_1", "2026-06-22T12:00:04.000Z", ["m1", "r1", "r2", "r3", "r4"]),
      makeMessage("r4", "2026-06-22T12:00:04.000Z")
    )
    const row = await db.conversations.get("conv_1")
    expect(row?.recentMessages.map((m) => m.id)).toEqual(["r2", "r3", "r4"])
    expect(row?.totalReplies).toBe(4)
  })

  it("recomputes the reply count from the aggregate when a message is reassigned away", async () => {
    await seedBoardPosts(WORKSPACE_ID, [
      makePost("conv_1", "2026-06-20T12:00:00.000Z", [makeMessage("r1"), makeMessage("r2")]),
    ])
    // No triggering body: a reassignment shrank the conversation's messageIds.
    await mergeBoardConversation("conv_1", makeConversation("conv_1", "2026-06-22T12:00:00.000Z", ["m1", "r1"]))
    const row = await db.conversations.get("conv_1")
    expect(row?.totalReplies).toBe(1)
  })

  it("ignores a triggering body that isn't a primary reply of this conversation", async () => {
    await seedBoardPosts(WORKSPACE_ID, [makePost("conv_1", "2026-06-20T12:00:00.000Z", [makeMessage("r1")])])
    await mergeBoardConversation(
      "conv_1",
      makeConversation("conv_1", "2026-06-22T12:00:00.000Z", ["m1", "r1"]),
      makeMessage("secondary_x", "2026-06-22T12:00:00.000Z")
    )
    const row = await db.conversations.get("conv_1")
    expect(row?.recentMessages.map((m) => m.id)).toEqual(["r1"])
  })

  it("returns false when the card isn't cached (caller hydrates instead)", async () => {
    const merged = await mergeBoardConversation(
      "conv_absent",
      makeConversation("conv_absent", "2026-06-22T12:00:00.000Z")
    )
    expect(merged).toBe(false)
    expect(await readBoard()).toHaveLength(0)
  })

  it("clears the optimistic pending flag when the authoritative echo merges over it", async () => {
    await seedBoardPosts(WORKSPACE_ID, [makePost("conv_1", "2026-06-20T12:00:00.000Z")])
    await optimisticBoardReply("conv_1", makeMessage("r1"), Date.parse("2026-06-21T12:00:00.000Z"))
    expect((await db.conversations.get("conv_1"))?._status).toBe("pending")
    await mergeBoardConversation(
      "conv_1",
      makeConversation("conv_1", "2026-06-21T12:00:05.000Z", ["m1", "r1"]),
      makeMessage("r1")
    )
    expect((await db.conversations.get("conv_1"))?._status).toBeUndefined()
  })
})

describe("optimisticBoardReply", () => {
  it("appends the reply, bumps activity to the top, and marks the row pending", async () => {
    await seedBoardPosts(WORKSPACE_ID, [
      makePost("conv_1", "2026-06-20T12:00:00.000Z"),
      makePost("conv_2", "2026-06-21T12:00:00.000Z"),
    ])
    await optimisticBoardReply("conv_1", makeMessage("r1"), Date.parse("2026-06-22T12:00:00.000Z"))
    const board = await readBoard()
    expect(board.map((p) => p.id)).toEqual(["conv_1", "conv_2"])
    expect(board[0]?.recentMessages.map((m) => m.id)).toEqual(["r1"])
    expect(board[0]?.totalReplies).toBe(1)
    expect(board[0]?._status).toBe("pending")
  })

  it("caps the preview at the latest three replies", async () => {
    await seedBoardPosts(WORKSPACE_ID, [
      makePost("conv_1", "2026-06-20T12:00:00.000Z", [makeMessage("r1"), makeMessage("r2"), makeMessage("r3")]),
    ])
    await optimisticBoardReply("conv_1", makeMessage("r4"), Date.parse("2026-06-22T12:00:00.000Z"))
    const row = await db.conversations.get("conv_1")
    expect(row?.recentMessages.map((m) => m.id)).toEqual(["r2", "r3", "r4"])
  })

  it("is a no-op when the conversation isn't cached", async () => {
    await optimisticBoardReply("conv_absent", makeMessage("r1"), Date.now())
    expect(await readBoard()).toHaveLength(0)
  })
})
