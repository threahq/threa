import { describe, expect, it } from "bun:test"
import {
  buildMemoHref,
  buildSharedMessageHref,
  parseMemoHref,
  parseMentionPointerHref,
  parseSharedMessageHref,
} from "./pointer-urls"

describe("parseMentionPointerHref", () => {
  it("decodes user/persona/bot mention schemes to kind + id + type", () => {
    expect(parseMentionPointerHref("user:usr_1")).toEqual({ kind: "mention", mentionType: "user", id: "usr_1" })
    expect(parseMentionPointerHref("persona:persona_1")).toEqual({
      kind: "mention",
      mentionType: "persona",
      id: "persona_1",
    })
    expect(parseMentionPointerHref("bot:bot_1")).toEqual({ kind: "mention", mentionType: "bot", id: "bot_1" })
  })

  it("decodes broadcast sentinels (id is the full sentinel)", () => {
    expect(parseMentionPointerHref("broadcast:here")).toEqual({
      kind: "mention",
      mentionType: "broadcast",
      id: "broadcast:here",
    })
    expect(parseMentionPointerHref("broadcast:channel")).toEqual({
      kind: "mention",
      mentionType: "broadcast",
      id: "broadcast:channel",
    })
  })

  it("decodes a channel scheme to a stream id", () => {
    expect(parseMentionPointerHref("channel:stream_1")).toEqual({ kind: "channel", id: "stream_1" })
  })

  it("returns null for non-pointer hrefs and empty ids", () => {
    expect(parseMentionPointerHref("https://example.com")).toBeNull()
    expect(parseMentionPointerHref("attachment:att_1")).toBeNull()
    expect(parseMentionPointerHref("memo:memo_1")).toBeNull()
    expect(parseMentionPointerHref("broadcast:everyone")).toBeNull()
    expect(parseMentionPointerHref("user:")).toBeNull()
    expect(parseMentionPointerHref("channel:")).toBeNull()
  })

  it("returns null when the id prefix mismatches the scheme (INV-64, INV-2)", () => {
    expect(parseMentionPointerHref("user:persona_1")).toBeNull()
    expect(parseMentionPointerHref("persona:usr_1")).toBeNull()
    expect(parseMentionPointerHref("bot:usr_1")).toBeNull()
    expect(parseMentionPointerHref("channel:usr_1")).toBeNull()
  })
})

describe("shared-message href", () => {
  it("round-trips a two-segment (in-stream) pointer with no conversation origin", () => {
    const href = buildSharedMessageHref({ streamId: "stream_01ABC", messageId: "msg_01XYZ" })
    expect(href).toBe("shared-message:stream_01ABC/msg_01XYZ")
    expect(parseSharedMessageHref(href)).toEqual({
      streamId: "stream_01ABC",
      messageId: "msg_01XYZ",
      conversationId: undefined,
    })
  })

  it("round-trips a conversation-origin pointer with the third segment", () => {
    const href = buildSharedMessageHref({
      streamId: "stream_01ABC",
      messageId: "msg_01XYZ",
      conversationId: "conv_01DEF",
    })
    expect(href).toBe("shared-message:stream_01ABC/msg_01XYZ/conv_01DEF")
    expect(parseSharedMessageHref(href)).toEqual({
      streamId: "stream_01ABC",
      messageId: "msg_01XYZ",
      conversationId: "conv_01DEF",
    })
  })

  it("parses a legacy two-segment link with conversationId undefined (backward compat)", () => {
    expect(parseSharedMessageHref("shared-message:stream_1/msg_1")).toEqual({
      streamId: "stream_1",
      messageId: "msg_1",
      conversationId: undefined,
    })
  })

  it("returns null for a non-shared-message href or a single segment", () => {
    expect(parseSharedMessageHref("memo:memo_1")).toBeNull()
    expect(parseSharedMessageHref("shared-message:stream_1")).toBeNull()
  })
})

describe("parseMemoHref", () => {
  it("round-trips a canonical memo id", () => {
    const href = buildMemoHref({ memoId: "memo_01ABC" })
    expect(href).toBe("memo:memo_01ABC")
    expect(parseMemoHref(href)).toEqual({ memoId: "memo_01ABC" })
  })

  it("returns null for a non-memo href", () => {
    expect(parseMemoHref("shared-message:stream_1/msg_1")).toBeNull()
    expect(parseMemoHref("https://example.com")).toBeNull()
  })

  it("returns null for an empty id", () => {
    expect(parseMemoHref("memo:")).toBeNull()
  })

  it("rejects ids with a path, query, or fragment suffix", () => {
    expect(parseMemoHref("memo:memo_123/extra")).toBeNull()
    expect(parseMemoHref("memo:memo_123?x=1")).toBeNull()
    expect(parseMemoHref("memo:memo_123#frag")).toBeNull()
    expect(parseMemoHref("memo:memo_123:more")).toBeNull()
  })
})
