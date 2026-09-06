import { describe, expect, test } from "bun:test"
import type { Memo, MemoExplorerResult } from "../memos"
import { buildSearchClusters } from "./clusters"
import type { ConversationForMessage, ConversationSearchResult, SearchResult } from "./repository"

const K = 60

function message(id: string, overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id,
    streamId: "stream_1",
    content: `content for ${id}`,
    authorId: "usr_1",
    authorType: "user",
    sequence: 1n,
    replyCount: 0,
    metadata: {},
    editedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    rank: 0,
    ...overrides,
  }
}

function conversation(id: string, overrides: Partial<ConversationForMessage> = {}): ConversationForMessage {
  return {
    id,
    streamId: "stream_1",
    topicSummary: `topic ${id}`,
    summary: null,
    status: "resolved",
    messageCount: 3,
    participantIds: ["usr_1"],
    firstMessageId: null,
    firstMessageAt: null,
    lastMessageAt: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  }
}

function topicHit(id: string, distance: number): ConversationSearchResult {
  return { ...conversation(id), distance }
}

function memoHit(id: string, sourceMessageIds: string[]): MemoExplorerResult {
  const memo: Memo = {
    id,
    workspaceId: "ws_1",
    memoType: "message",
    sourceMessageId: sourceMessageIds[0] ?? null,
    sourceConversationId: null,
    title: `memo ${id}`,
    abstract: "",
    keyPoints: [],
    sourceMessageIds,
    participantIds: [],
    knowledgeType: "decision",
    tags: [],
    parentMemoId: null,
    status: "active",
    version: 1,
    revisionReason: null,
    authoredByKind: "pipeline",
    sourceSessionId: null,
    scope: "workspace",
    scopeUserId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    archivedAt: null,
  }
  return { memo, distance: 0.1, sourceStream: { id: "stream_1", type: "scratchpad", name: null }, rootStream: null }
}

const rrf = (...positions: number[]) => positions.reduce((sum, p) => sum + 1 / (K + p), 0)

describe("buildSearchClusters", () => {
  test("should group message hits under their conversation and score by reciprocal rank when several land on one row", () => {
    const conv = conversation("conv_a")
    const clusters = buildSearchClusters({
      results: [message("msg_1"), message("msg_2"), message("msg_3")],
      conversations: [],
      memos: [],
      conversationByMessageId: new Map([
        ["msg_1", conv],
        ["msg_3", conv],
      ]),
      sourceMessages: [],
      k: K,
    })

    expect(clusters).toEqual([
      {
        conversation: conv,
        streamId: "stream_1",
        matchedVia: ["message"],
        hits: [message("msg_1"), message("msg_3")],
        memoIds: [],
        score: rrf(1, 3),
      },
      {
        conversation: null,
        streamId: "stream_1",
        matchedVia: ["message"],
        hits: [message("msg_2")],
        memoIds: [],
        score: rrf(2),
      },
    ])
  })

  test("should add a topic match to the conversation row when its messages also hit, and stand alone otherwise", () => {
    const conv = conversation("conv_a")
    const clusters = buildSearchClusters({
      results: [message("msg_1")],
      conversations: [topicHit("conv_b", 0.2), topicHit("conv_a", 0.3)],
      memos: [],
      conversationByMessageId: new Map([["msg_1", conv]]),
      sourceMessages: [],
      k: K,
    })

    expect(clusters).toEqual([
      {
        conversation: conv,
        streamId: "stream_1",
        matchedVia: ["message", "topic"],
        hits: [message("msg_1")],
        memoIds: [],
        score: rrf(1, 2),
      },
      {
        conversation: conversation("conv_b"),
        streamId: "stream_1",
        matchedVia: ["topic"],
        hits: [],
        memoIds: [],
        score: rrf(1),
      },
    ])
  })

  test("should land a memo on the row of its first anchored source message without adding source messages to a row that has hits", () => {
    const conv = conversation("conv_a")
    const clusters = buildSearchClusters({
      results: [message("msg_1")],
      conversations: [],
      memos: [memoHit("memo_1", ["msg_9", "msg_1", "msg_2"])],
      conversationByMessageId: new Map([["msg_1", conv]]),
      sourceMessages: [message("msg_9"), message("msg_2")],
      k: K,
    })

    expect(clusters).toEqual([
      {
        conversation: conv,
        streamId: "stream_1",
        matchedVia: ["message", "memory"],
        hits: [message("msg_1")],
        memoIds: ["memo_1"],
        score: rrf(1, 1),
      },
    ])
  })

  test("should give a memo whose sources belong to an unmatched conversation that conversation's row with the sources as hits", () => {
    const conv = conversation("conv_a")
    const clusters = buildSearchClusters({
      results: [],
      conversations: [],
      memos: [memoHit("memo_1", ["msg_1", "msg_2"])],
      conversationByMessageId: new Map([
        ["msg_1", conv],
        ["msg_2", conv],
      ]),
      sourceMessages: [message("msg_1"), message("msg_2")],
      k: K,
    })

    expect(clusters).toEqual([
      {
        conversation: conv,
        streamId: "stream_1",
        matchedVia: ["memory"],
        hits: [message("msg_1"), message("msg_2")],
        memoIds: ["memo_1"],
        score: rrf(1),
      },
    ])
  })

  test("should make a memo with no anchored source its own row carrying its readable source messages", () => {
    const clusters = buildSearchClusters({
      results: [],
      conversations: [],
      memos: [memoHit("memo_1", ["msg_1", "msg_hidden"])],
      conversationByMessageId: new Map(),
      sourceMessages: [message("msg_1", { streamId: "stream_2" })],
      k: K,
    })

    expect(clusters).toEqual([
      {
        conversation: null,
        streamId: "stream_2",
        matchedVia: ["memory"],
        hits: [message("msg_1", { streamId: "stream_2" })],
        memoIds: ["memo_1"],
        score: rrf(1),
      },
    ])
  })

  test("should drop a memo whose sources are all unreadable and whose source stream is unknown", () => {
    const orphan = memoHit("memo_1", ["msg_hidden"])
    const clusters = buildSearchClusters({
      results: [],
      conversations: [],
      memos: [{ ...orphan, sourceStream: null }],
      conversationByMessageId: new Map(),
      sourceMessages: [],
      k: K,
    })

    expect(clusters).toEqual([])
  })

  test("should order rows by score, then by latest activity", () => {
    const older = conversation("conv_old", { lastMessageAt: new Date("2026-01-01T00:00:00Z") })
    const newer = conversation("conv_new", { lastMessageAt: new Date("2026-03-01T00:00:00Z") })
    const clusters = buildSearchClusters({
      results: [message("msg_1"), message("msg_2"), message("msg_3")],
      conversations: [topicHit("conv_new", 0.1), topicHit("conv_old", 0.2)],
      memos: [],
      conversationByMessageId: new Map([
        ["msg_2", older],
        ["msg_3", newer],
      ]),
      sourceMessages: [],
      k: K,
    })

    expect(clusters.map((c) => [c.conversation?.id ?? c.hits[0]!.id, c.score])).toEqual([
      ["conv_new", rrf(3, 1)],
      ["conv_old", rrf(2, 2)],
      ["msg_1", rrf(1)],
    ])
  })
})
