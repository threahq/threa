import { describe, expect, it } from "bun:test"

import { isThreaDocument, validateContent, type JSONContent } from "./prosemirror"

const pinnedQuote = (attrs: Record<string, unknown>): JSONContent => ({
  type: "doc",
  content: [
    {
      type: "quoteReply",
      attrs: {
        messageId: "msg_1",
        streamId: "stream_1",
        authorName: "Alice",
        authorId: "usr_1",
        actorType: "user",
        snippet: "hello",
        ...attrs,
      },
    },
  ],
})

describe("reference pins survive validation", () => {
  it("keeps version and range on a quoteReply", () => {
    const doc = pinnedQuote({ version: 2, range: { from: 1, to: 6 } })
    expect(validateContent(doc) as JSONContent).toEqual(doc)
  })

  it("keeps version and range on a sharedMessage", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "sharedMessage",
          attrs: { messageId: "msg_1", streamId: "stream_1", version: 4, range: { from: 0, to: 3 } },
        },
      ],
    }
    expect(validateContent(doc) as JSONContent).toEqual(doc)
  })

  it("accepts an explicit null pin and a legacy node with no pin at all", () => {
    expect(isThreaDocument(pinnedQuote({ version: null, range: null }))).toBe(true)
    expect(isThreaDocument(pinnedQuote({}))).toBe(true)
  })

  it("rejects a reversed range and a range without a version", () => {
    expect(isThreaDocument(pinnedQuote({ version: 1, range: { from: 3, to: 2 } }))).toBe(false)
    expect(isThreaDocument(pinnedQuote({ range: { from: 0, to: 3 } }))).toBe(false)
    expect(isThreaDocument(pinnedQuote({ version: null, range: { from: 0, to: 3 } }))).toBe(false)
  })

  it("rejects a non-positive version and a fractional or negative range", () => {
    expect(isThreaDocument(pinnedQuote({ version: 0 }))).toBe(false)
    expect(isThreaDocument(pinnedQuote({ version: 1.5 }))).toBe(false)
    expect(isThreaDocument(pinnedQuote({ version: 1, range: { from: -1, to: 3 } }))).toBe(false)
    expect(isThreaDocument(pinnedQuote({ version: 1, range: { from: 0, to: 0 } }))).toBe(false)
  })
})
