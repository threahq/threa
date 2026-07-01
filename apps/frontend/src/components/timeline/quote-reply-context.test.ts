import { describe, it, expect } from "vitest"
import type { JSONContent } from "@threa/types"
import { appendQuoteReplyNode, type QuoteReplyData } from "./quote-reply-context"

const DATA: QuoteReplyData = {
  messageId: "msg_1",
  streamId: "stream_1",
  authorName: "Ada",
  authorId: "usr_1",
  actorType: "user",
  snippet: "the quoted body",
}

function quoteNode(): JSONContent {
  return {
    type: "quoteReply",
    attrs: {
      messageId: DATA.messageId,
      streamId: DATA.streamId,
      authorName: DATA.authorName,
      authorId: DATA.authorId,
      actorType: DATA.actorType,
      snippet: DATA.snippet,
    },
  }
}

describe("appendQuoteReplyNode", () => {
  it("appends the quote to existing content, keeping one trailing paragraph to type in", () => {
    const content: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "already typed" }] }],
    }

    expect(appendQuoteReplyNode(content, DATA)).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "already typed" }] },
        quoteNode(),
        { type: "paragraph" },
      ],
    })
  })

  it("strips trailing empty paragraphs so the quote appends cleanly on an empty composer", () => {
    const content: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }

    expect(appendQuoteReplyNode(content, DATA)).toEqual({
      type: "doc",
      content: [quoteNode(), { type: "paragraph" }],
    })
  })

  it("handles content with no blocks", () => {
    expect(appendQuoteReplyNode({ type: "doc" }, DATA)).toEqual({
      type: "doc",
      content: [quoteNode(), { type: "paragraph" }],
    })
  })
})
