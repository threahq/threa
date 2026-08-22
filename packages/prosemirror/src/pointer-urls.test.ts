import { describe, expect, it } from "bun:test"
import {
  buildAgentBlockHref,
  buildMemoHref,
  buildQuoteHref,
  buildSharedMessageHref,
  parseAgentBlockHref,
  parseMemoHref,
  parseMentionPointerHref,
  parseQuoteHref,
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
      version: null,
      range: null,
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
      version: null,
      range: null,
    })
  })

  it("parses a legacy two-segment link with conversationId undefined (backward compat)", () => {
    expect(parseSharedMessageHref("shared-message:stream_1/msg_1")).toEqual({
      streamId: "stream_1",
      messageId: "msg_1",
      conversationId: undefined,
      version: null,
      range: null,
    })
  })

  it("returns null for a non-shared-message href, a single segment, or too many segments", () => {
    expect(parseSharedMessageHref("memo:memo_1")).toBeNull()
    expect(parseSharedMessageHref("shared-message:stream_1")).toBeNull()
    // A malformed 4-segment href is rejected outright rather than silently
    // dropping the trailing data (parser-strictness parity with markdown.ts).
    expect(parseSharedMessageHref("shared-message:stream_1/msg_1/conv_1/extra")).toBeNull()
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

describe("reference pins", () => {
  const quote = { streamId: "stream_1", messageId: "msg_1", authorId: "usr_1", actorType: "user" }

  it("appends the version, and the range only alongside it", () => {
    expect(buildQuoteHref({ ...quote, version: 3 })).toBe("quote:stream_1/msg_1/usr_1/user?v=3")
    expect(buildQuoteHref({ ...quote, version: 3, range: { from: 4, to: 9 } })).toBe(
      "quote:stream_1/msg_1/usr_1/user?v=3&r=4-9"
    )
    expect(buildSharedMessageHref({ streamId: "stream_1", messageId: "msg_1", version: 2 })).toBe(
      "shared-message:stream_1/msg_1?v=2"
    )
    expect(
      buildSharedMessageHref({
        streamId: "stream_1",
        messageId: "msg_1",
        conversationId: "conv_1",
        version: 2,
        range: { from: 0, to: 3 },
      })
    ).toBe("shared-message:stream_1/msg_1/conv_1?v=2&r=0-3")
  })

  it("keeps the legacy suffix-free form when nothing is pinned", () => {
    expect(buildQuoteHref({ ...quote, version: null, range: null })).toBe("quote:stream_1/msg_1/usr_1/user")
    expect(
      buildQuoteHref({ streamId: "stream_1", messageId: "msg_1", authorId: "", actorType: "user", version: 5 })
    ).toBe("quote:stream_1/msg_1?v=5")
  })

  it("refuses to serialize a range without the version it indexes into", () => {
    expect(() => buildQuoteHref({ ...quote, range: { from: 1, to: 2 } })).toThrow("Invalid reference pin")
  })

  it("parses a pinned href back to the same values", () => {
    expect(parseQuoteHref("quote:stream_1/msg_1/usr_1/user?v=3&r=4-9")).toEqual({
      streamId: "stream_1",
      messageId: "msg_1",
      authorId: "usr_1",
      actorType: "user",
      version: 3,
      range: { from: 4, to: 9 },
    })
    expect(parseQuoteHref("quote:stream_1/msg_1")).toEqual({
      streamId: "stream_1",
      messageId: "msg_1",
      authorId: "",
      actorType: "user",
      version: null,
      range: null,
    })
  })

  it("rejects a malformed pin instead of reading the href as unpinned", () => {
    expect(parseQuoteHref("quote:stream_1/msg_1?v=abc")).toBeNull()
    expect(parseQuoteHref("quote:stream_1/msg_1?v=0")).toBeNull()
    expect(parseQuoteHref("quote:stream_1/msg_1?r=4-9")).toBeNull()
    expect(parseQuoteHref("quote:stream_1/msg_1?v=2&r=9-4")).toBeNull()
    expect(parseQuoteHref("quote:stream_1/msg_1?v=2&r=four")).toBeNull()
    expect(parseSharedMessageHref("shared-message:stream_1/msg_1?v=-1")).toBeNull()
  })

  it("rejects quote paths that are not the 2- or 4-segment shapes the builder emits", () => {
    expect(parseQuoteHref("quote:stream_1/msg_1/usr_1")).toBeNull()
    expect(parseQuoteHref("quote:stream_1/msg_1/usr_1/user/extra")).toBeNull()
    expect(parseQuoteHref("quote:stream_1//usr_1/user")).toBeNull()
  })

  it("builds and parses by the same pin rule", () => {
    expect(() =>
      buildQuoteHref({ streamId: "s", messageId: "m", authorId: "", actorType: "user", version: 0 })
    ).toThrow()
    expect(() =>
      buildQuoteHref({ streamId: "s", messageId: "m", authorId: "", actorType: "user", version: 1.5 })
    ).toThrow()
    expect(() =>
      buildSharedMessageHref({ streamId: "s", messageId: "m", version: 2, range: { from: 9, to: 4 } })
    ).toThrow()
    expect(parseQuoteHref(`quote:stream_1/msg_1?v=${"9".repeat(400)}`)).toBeNull()
    expect(parseQuoteHref("quote:stream_1/msg_1?v=2&r=99999999999999999999-999999999999999999999")).toBeNull()
  })

  it("ignores query parameters it does not know", () => {
    expect(parseQuoteHref("quote:stream_1/msg_1?v=2&x=1")?.version).toBe(2)
    expect(parseSharedMessageHref("shared-message:stream_1/msg_1?x=1")?.version).toBeNull()
  })
})

describe("parseAgentBlockHref", () => {
  it("round-trips a persona attribution with and without its source aside", () => {
    expect(buildAgentBlockHref({ authorId: "persona_01ARIADNE" })).toBe("agent:persona_01ARIADNE")
    expect(parseAgentBlockHref("agent:persona_01ARIADNE")).toEqual({ authorId: "persona_01ARIADNE" })

    const href = buildAgentBlockHref({ authorId: "bot_01X", sourceAsideId: "stream_01ASIDE" })
    expect(href).toBe("agent:bot_01X/stream_01ASIDE")
    expect(parseAgentBlockHref(href)).toEqual({ authorId: "bot_01X", sourceAsideId: "stream_01ASIDE" })
  })

  it("rejects an author that is not an agent, so a human can never be rendered as one", () => {
    expect(parseAgentBlockHref("agent:usr_01HUMAN")).toBeNull()
    expect(parseAgentBlockHref("agent:01NOPREFIX")).toBeNull()
    expect(parseAgentBlockHref("agent:")).toBeNull()
  })

  it("returns null for another scheme or a malformed shape", () => {
    expect(parseAgentBlockHref("quote:stream_1/msg_1")).toBeNull()
    expect(parseAgentBlockHref("agent:persona_1/stream_1/extra")).toBeNull()
    expect(parseAgentBlockHref("agent:persona_1/stream 1")).toBeNull()
  })
})
