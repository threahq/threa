import { describe, expect, it } from "bun:test"
import {
  OPENING_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  TOPIC_MAX_CHARS,
  buildConversationEmbeddingText,
  hashConversationEmbeddingText,
  isConversationEmbeddable,
} from "./embedding-text"

describe("isConversationEmbeddable", () => {
  it("requires at least one primary message and some summary text", () => {
    expect(isConversationEmbeddable({ topicSummary: "Topic", summary: null, messageIds: ["msg_1"] })).toBe(true)
    expect(isConversationEmbeddable({ topicSummary: null, summary: "Summary", messageIds: ["msg_1"] })).toBe(true)
    expect(isConversationEmbeddable({ topicSummary: "Topic", summary: "Summary", messageIds: [] })).toBe(false)
    expect(isConversationEmbeddable({ topicSummary: "   ", summary: null, messageIds: ["msg_1"] })).toBe(false)
    expect(isConversationEmbeddable({ topicSummary: null, summary: null, messageIds: ["msg_1"] })).toBe(false)
  })
})

describe("buildConversationEmbeddingText", () => {
  it("joins topic, summary and opening on their own lines, dropping blanks", () => {
    expect(
      buildConversationEmbeddingText({
        topicSummary: " Choosing the launch date ",
        summary: null,
        opening: "Should we go in May?",
      })
    ).toBe("Choosing the launch date\nShould we go in May?")
  })

  it("caps each line independently", () => {
    const text = buildConversationEmbeddingText({
      topicSummary: "t".repeat(TOPIC_MAX_CHARS + 50),
      summary: "s".repeat(SUMMARY_MAX_CHARS + 50),
      opening: "o".repeat(OPENING_MAX_CHARS + 50),
    })
    expect(text.split("\n").map((line) => line.length)).toEqual([TOPIC_MAX_CHARS, SUMMARY_MAX_CHARS, OPENING_MAX_CHARS])
  })
})

describe("hashConversationEmbeddingText", () => {
  it("changes when any line changes and is stable otherwise", () => {
    const a = hashConversationEmbeddingText("topic\nsummary")
    expect(hashConversationEmbeddingText("topic\nsummary")).toBe(a)
    expect(hashConversationEmbeddingText("topic\nsummary!")).not.toBe(a)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})
