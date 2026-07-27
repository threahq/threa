import { describe, expect, test } from "bun:test"
import { classificationFingerprint } from "./classification-fingerprint"
import type { Message } from "../messaging"
import type { Memo } from "./repository"

function message(overrides: Partial<Message> & { id: string }): Message {
  return {
    streamId: "stream_1",
    sequence: 1n,
    authorId: "usr_1",
    authorType: "user",
    contentJson: { type: "doc", content: [] },
    contentMarkdown: "hello",
    replyCount: 0,
    clientMessageId: null,
    sentVia: null,
    reactions: {},
    metadata: {},
    conversationIntent: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date("2026-07-01T10:00:00Z"),
    ciphertext: null,
    envelope: null,
    e2eVersion: null,
    ...overrides,
  } as Message
}

function memo(overrides: Partial<Memo> & { id: string }): Memo {
  return {
    workspaceId: "ws_1",
    memoType: "conversation",
    sourceMessageId: null,
    sourceConversationId: "conv_1",
    title: "Cache ordering",
    abstract: "Static block goes first.",
    keyPoints: [],
    sourceMessageIds: [],
    participantIds: [],
    knowledgeType: "decision",
    tags: [],
    parentMemoId: null,
    status: "active",
    version: 1,
    revisionReason: null,
    authoredByKind: "agent",
    sourceSessionId: null,
    scope: "workspace",
    scopeUserId: null,
    createdAt: new Date("2026-07-01T10:00:00Z"),
    updatedAt: new Date("2026-07-01T10:00:00Z"),
    archivedAt: null,
    ...overrides,
  } as Memo
}

const conversation = {
  status: "resolved" as const,
  topicSummary: "Cache-prefix ordering",
  participantIds: ["usr_1", "usr_2"],
  messageIds: ["msg_1", "msg_2"],
}
const messages = [message({ id: "msg_1" }), message({ id: "msg_2" })]
const memos = [memo({ id: "memo_1" })]

const baseline = classificationFingerprint(conversation, messages, memos)

describe("classificationFingerprint", () => {
  test("is stable across passes when nothing has moved", () => {
    // Re-derived from freshly built inputs, as a later batch would do.
    const again = classificationFingerprint(
      { ...conversation, participantIds: ["usr_2", "usr_1"] },
      [message({ id: "msg_1" }), message({ id: "msg_2" })],
      [memo({ id: "memo_1" })]
    )

    expect(again).toBe(baseline)
  })

  test("changes when a message is added", () => {
    const changed = classificationFingerprint(
      { ...conversation, messageIds: ["msg_1", "msg_2", "msg_3"] },
      [...messages, message({ id: "msg_3" })],
      memos
    )

    expect(changed).not.toBe(baseline)
  })

  test("changes when a message is edited, though the id list is identical", () => {
    const changed = classificationFingerprint(
      conversation,
      [message({ id: "msg_1", editedAt: new Date("2026-07-02T09:00:00Z") }), message({ id: "msg_2" })],
      memos
    )

    expect(changed).not.toBe(baseline)
  })

  test("changes when a message is deleted", () => {
    const changed = classificationFingerprint(
      conversation,
      [message({ id: "msg_1", deletedAt: new Date("2026-07-02T09:00:00Z") }), message({ id: "msg_2" })],
      memos
    )

    expect(changed).not.toBe(baseline)
  })

  test("changes when the conversation is reopened", () => {
    const changed = classificationFingerprint({ ...conversation, status: "active" }, messages, memos)

    expect(changed).not.toBe(baseline)
  })

  test("changes when the topic summary is rewritten", () => {
    const changed = classificationFingerprint({ ...conversation, topicSummary: "Something else" }, messages, memos)

    expect(changed).not.toBe(baseline)
  })

  test("changes when a participant joins", () => {
    const changed = classificationFingerprint(
      { ...conversation, participantIds: ["usr_1", "usr_2", "usr_3"] },
      messages,
      memos
    )

    expect(changed).not.toBe(baseline)
  })

  // The classifier is asked `shouldReviseExisting` against these memos, so a
  // memo edited or superseded elsewhere changes the correct answer even though
  // the conversation itself has stood still.
  test("changes when an existing memo is revised", () => {
    const changed = classificationFingerprint(conversation, messages, [memo({ id: "memo_1", version: 2 })])

    expect(changed).not.toBe(baseline)
  })

  test("changes when a memo is added to the conversation", () => {
    const changed = classificationFingerprint(conversation, messages, [...memos, memo({ id: "memo_2" })])

    expect(changed).not.toBe(baseline)
  })

  test("ignores the ordering of memos and participants", () => {
    const reordered = classificationFingerprint({ ...conversation, participantIds: ["usr_2", "usr_1"] }, messages, [
      memo({ id: "memo_2" }),
      memo({ id: "memo_1" }),
    ])
    const forward = classificationFingerprint(conversation, messages, [memo({ id: "memo_1" }), memo({ id: "memo_2" })])

    expect(reordered).toBe(forward)
  })

  test("distinguishes a message the batch could not load from one it could", () => {
    const changed = classificationFingerprint(conversation, [message({ id: "msg_1" })], memos)

    expect(changed).not.toBe(baseline)
  })
})
