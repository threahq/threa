import { describe, it, expect } from "vitest"
import type { JSONContent } from "@threa/types"
import { buildPartialQuote, resolveQuoteSelection } from "./quote-selection"

const doc: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "the quick brown fox" }] }],
}

describe("buildPartialQuote", () => {
  it("should pin the span and render the slice when the revision is known", () => {
    expect(buildPartialQuote({ contentJson: doc, revision: 3, selectionText: "quick brown" })).toEqual({
      version: 3,
      range: { from: 5, to: 16 },
      snippet: "quick brown",
    })
  })

  it("should refuse to pin a span when the revision is unknown", () => {
    expect(buildPartialQuote({ contentJson: doc, revision: null, selectionText: "quick brown" })).toBeNull()
  })

  it("should return null when the selection matches nothing", () => {
    expect(buildPartialQuote({ contentJson: doc, revision: 3, selectionText: "not in here" })).toBeNull()
  })
})

describe("resolveQuoteSelection", () => {
  it("should send the whole message unranged when the row carries no revision", () => {
    expect(
      resolveQuoteSelection(
        { contentJson: doc, revision: null, contentMarkdown: "the quick brown fox" },
        { text: "quick brown", prefixText: "the " }
      )
    ).toEqual({ version: null, range: null, snippet: "the quick brown fox" })
  })

  it("should fall back to the whole pinned message when the selection cannot be located", () => {
    expect(
      resolveQuoteSelection(
        { contentJson: doc, revision: 2, contentMarkdown: "the quick brown fox" },
        { text: "elsewhere", prefixText: "" }
      )
    ).toEqual({ version: 2, range: null, snippet: "the quick brown fox" })
  })

  it("should send the lenient unpinned form when the row's content is out of reach", () => {
    expect(resolveQuoteSelection(null, { text: "quick brown", prefixText: "the " })).toEqual({
      version: null,
      range: null,
      snippet: "quick brown",
    })
  })
})
