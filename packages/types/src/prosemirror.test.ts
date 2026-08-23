import { describe, expect, it } from "bun:test"

import { isThreaDocument, tryValidateContent, validateContent, type JSONContent } from "./prosemirror"

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

const agentBlock = (attrs: Record<string, unknown>) => ({
  type: "doc",
  content: [
    {
      type: "agentBlock",
      attrs,
      content: [{ type: "paragraph", content: [{ type: "text", text: "Two options." }] }],
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

describe("agentBlock validation", () => {
  it("accepts a stored agent block for a persona or a bot", () => {
    expect(isThreaDocument(agentBlock({ authorId: "persona_1", authorName: "Ariadne" }))).toBe(true)
    expect(isThreaDocument(agentBlock({ authorId: "bot_1", authorName: "Deploybot" }))).toBe(true)
  })

  it("rejects an agent block whose author is not an agent id, or whose name is empty", () => {
    expect(isThreaDocument(agentBlock({ authorId: "", authorName: "Ariadne" }))).toBe(false)
    expect(isThreaDocument(agentBlock({ authorId: "usr_01HUMAN", authorName: "Alice" }))).toBe(false)
    expect(isThreaDocument(agentBlock({ authorId: `persona_${"x".repeat(70)}`, authorName: "Ariadne" }))).toBe(false)
    expect(isThreaDocument(agentBlock({ authorId: "persona_1", authorName: "" }))).toBe(false)
  })

  it("accepts an agent block nested inside a list item", () => {
    expect(
      isThreaDocument({
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              { type: "listItem", content: agentBlock({ authorId: "persona_1", authorName: "Ariadne" }).content },
            ],
          },
        ],
      })
    ).toBe(true)
  })

  it("rejects an agent block missing its attribution", () => {
    expect(tryValidateContent(agentBlock({ authorName: "Ariadne" }))).toBeNull()
    expect(tryValidateContent(agentBlock({ authorId: "persona_1" }))).toBeNull()
  })
})
