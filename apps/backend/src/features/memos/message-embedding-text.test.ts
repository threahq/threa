import { describe, expect, it } from "bun:test"
import {
  ANCHOR_MAX_CHARS,
  CONTENT_MAX_CHARS,
  PRECEDING_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  TOPIC_MAX_CHARS,
  buildMessageEmbeddingText,
} from "./message-embedding-text"

describe("buildMessageEmbeddingText", () => {
  it("should render a header with the stream name when the stream is named", () => {
    const text = buildMessageEmbeddingText({
      streamType: "channel",
      streamName: "engineering",
      topic: null,
      summary: null,
      anchor: null,
      preceding: [],
      content: "ship it",
    })

    expect(text).toBe("channel: engineering\n\nship it")
  })

  it("should render just the stream type when the stream has no name", () => {
    const text = buildMessageEmbeddingText({
      streamType: "thread",
      streamName: null,
      topic: null,
      summary: null,
      anchor: null,
      preceding: [],
      content: "yes, ship it",
    })

    expect(text).toBe("thread\n\nyes, ship it")
  })

  it("should include the anchor when non-empty", () => {
    const text = buildMessageEmbeddingText({
      streamType: "thread",
      streamName: null,
      topic: null,
      summary: null,
      anchor: "should we ship the search change today?",
      preceding: [],
      content: "yes, ship it",
    })

    expect(text).toBe("thread\nshould we ship the search change today?\n\nyes, ship it")
  })

  it("should omit the anchor when empty", () => {
    const text = buildMessageEmbeddingText({
      streamType: "thread",
      streamName: null,
      topic: null,
      summary: null,
      anchor: "",
      preceding: [],
      content: "yes, ship it",
    })

    expect(text).toBe("thread\n\nyes, ship it")
  })

  it("should truncate the anchor to ANCHOR_MAX_CHARS", () => {
    const anchor = "a".repeat(ANCHOR_MAX_CHARS + 50)
    const text = buildMessageEmbeddingText({
      streamType: "thread",
      streamName: null,
      topic: null,
      summary: null,
      anchor,
      preceding: [],
      content: "yes, ship it",
    })

    expect(text).toBe(`thread\n${"a".repeat(ANCHOR_MAX_CHARS)}\n\nyes, ship it`)
  })

  it("should include preceding messages oldest first", () => {
    const text = buildMessageEmbeddingText({
      streamType: "channel",
      streamName: "engineering",
      topic: null,
      summary: null,
      anchor: null,
      preceding: ["what do you think about the plan?", "any concerns?"],
      content: "yes, ship it",
    })

    expect(text).toBe("channel: engineering\nwhat do you think about the plan?\nany concerns?\n\nyes, ship it")
  })

  it("should omit empty preceding messages", () => {
    const text = buildMessageEmbeddingText({
      streamType: "channel",
      streamName: "engineering",
      topic: null,
      summary: null,
      anchor: null,
      preceding: ["what do you think?", "", "any concerns?"],
      content: "yes, ship it",
    })

    expect(text).toBe("channel: engineering\nwhat do you think?\nany concerns?\n\nyes, ship it")
  })

  it("should truncate each preceding message to PRECEDING_MAX_CHARS", () => {
    const long = "b".repeat(PRECEDING_MAX_CHARS + 50)
    const text = buildMessageEmbeddingText({
      streamType: "channel",
      streamName: "engineering",
      topic: null,
      summary: null,
      anchor: null,
      preceding: [long],
      content: "yes, ship it",
    })

    expect(text).toBe(`channel: engineering\n${"b".repeat(PRECEDING_MAX_CHARS)}\n\nyes, ship it`)
  })

  it("should keep only the last 3 preceding messages when more are passed", () => {
    const text = buildMessageEmbeddingText({
      streamType: "channel",
      streamName: "engineering",
      topic: null,
      summary: null,
      anchor: null,
      preceding: ["msg 1", "msg 2", "msg 3", "msg 4", "msg 5"],
      content: "yes, ship it",
    })

    expect(text).toBe("channel: engineering\nmsg 3\nmsg 4\nmsg 5\n\nyes, ship it")
  })

  it("should truncate the content to CONTENT_MAX_CHARS", () => {
    const content = "c".repeat(CONTENT_MAX_CHARS + 100)
    const text = buildMessageEmbeddingText({
      streamType: "channel",
      streamName: null,
      topic: null,
      summary: null,
      anchor: null,
      preceding: [],
      content,
    })

    expect(text).toBe(`channel\n\n${"c".repeat(CONTENT_MAX_CHARS)}`)
  })

  it("should order header, anchor, preceding, blank line, then content", () => {
    const text = buildMessageEmbeddingText({
      streamType: "thread",
      streamName: null,
      topic: null,
      summary: null,
      anchor: "should we ship the search change today?",
      preceding: ["I think so", "any blockers?"],
      content: "yes, ship it",
    })

    expect(text).toBe("thread\nshould we ship the search change today?\nI think so\nany blockers?\n\nyes, ship it")
  })

  it("should render the topic under the header", () => {
    const text = buildMessageEmbeddingText({
      streamType: "channel",
      streamName: "engineering",
      topic: "Shipping the search change",
      summary: null,
      anchor: null,
      preceding: [],
      content: "yes, ship it",
    })

    expect(text).toBe("channel: engineering\nShipping the search change\n\nyes, ship it")
  })

  it("should render the summary after the topic", () => {
    const text = buildMessageEmbeddingText({
      streamType: "channel",
      streamName: "engineering",
      topic: "Shipping the search change",
      summary: "Whether to ship on Friday",
      anchor: null,
      preceding: [],
      content: "yes, ship it",
    })

    expect(text).toBe("channel: engineering\nShipping the search change\nWhether to ship on Friday\n\nyes, ship it")
  })

  it("should truncate the topic to TOPIC_MAX_CHARS and the summary to SUMMARY_MAX_CHARS", () => {
    const topic = "t".repeat(TOPIC_MAX_CHARS + 50)
    const summary = "s".repeat(SUMMARY_MAX_CHARS + 50)
    const text = buildMessageEmbeddingText({
      streamType: "channel",
      streamName: "engineering",
      topic,
      summary,
      anchor: null,
      preceding: [],
      content: "yes, ship it",
    })

    expect(text).toBe(
      `channel: engineering\n${"t".repeat(TOPIC_MAX_CHARS)}\n${"s".repeat(SUMMARY_MAX_CHARS)}\n\nyes, ship it`
    )
  })
})
