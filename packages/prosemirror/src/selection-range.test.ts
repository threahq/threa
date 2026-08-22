import { describe, expect, it } from "bun:test"
import type { JSONContent } from "@threa/types"

import { resolveSelectionRange } from "./selection-range"
import { sliceContent } from "./slice"

const mention: JSONContent = { type: "mention", attrs: { id: "usr_1", slug: "alice", mentionType: "user" } }

const paragraph = (...content: JSONContent[]): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content }],
})

const text = (value: string, ...marks: string[]): JSONContent =>
  marks.length > 0
    ? { type: "text", text: value, marks: marks.map((type) => ({ type })) }
    : { type: "text", text: value }

describe("resolveSelectionRange", () => {
  it("locates a word sequence inside a paragraph", () => {
    const doc = paragraph(text("The quick brown fox"))
    expect(resolveSelectionRange(doc, { text: "quick brown" })).toEqual({ from: 5, to: 16 })
  })

  it("locates a word that marks split across text nodes", () => {
    const doc = paragraph(text("Hel"), text("lo", "bold"), text(" world"))
    const range = resolveSelectionRange(doc, { text: "Hello world" })
    expect(range).toEqual({ from: 1, to: 12 })
    expect(sliceContent(doc, range!.from, range!.to)).toEqual(doc)
  })

  it("matches partial first and last words", () => {
    const doc = paragraph(text("Hello world"))
    expect(resolveSelectionRange(doc, { text: "llo wor" })).toEqual({ from: 3, to: 10 })
  })

  it("consumes a mention's rendered label between two words", () => {
    const doc = paragraph(text("hi "), mention, text(" there"))
    expect(resolveSelectionRange(doc, { text: "hi @alice there" })).toEqual({ from: 1, to: 11 })
  })

  it("starts at a mention when the selection opens with its label", () => {
    const doc = paragraph(mention, text(" hi"))
    expect(resolveSelectionRange(doc, { text: "@alice hi" })).toEqual({ from: 1, to: 5 })
  })

  it("ends at a mention when the selection closes with its label", () => {
    const doc = paragraph(text("hi "), mention)
    expect(resolveSelectionRange(doc, { text: "hi @alice" })).toEqual({ from: 1, to: 5 })
  })

  it("selects the mention alone when only its label is selected", () => {
    const doc = paragraph(text("hi "), mention, text(" there"))
    expect(resolveSelectionRange(doc, { text: "@alice" })).toEqual({ from: 4, to: 5 })
  })

  it("spans paragraphs when the selection crosses a block boundary", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [text("first line")] },
        { type: "paragraph", content: [text("second line")] },
      ],
    }
    expect(resolveSelectionRange(doc, { text: "line second" })).toEqual({ from: 7, to: 19 })
  })

  it("picks the repeat closest to the prefix text's word count", () => {
    const doc = paragraph(text("foo bar baz foo bar"))
    expect(resolveSelectionRange(doc, { text: "foo bar" })).toEqual({ from: 1, to: 8 })
    expect(resolveSelectionRange(doc, { text: "foo bar", prefixText: "foo bar baz " })).toEqual({ from: 13, to: 20 })
  })

  it("counts an atom as one word when scoring the prefix text", () => {
    const doc = paragraph(text("foo "), mention, text(" foo foo foo"))
    expect(resolveSelectionRange(doc, { text: "foo", prefixText: "foo @alice " })).toEqual({ from: 7, to: 10 })
    expect(resolveSelectionRange(doc, { text: "foo", prefixText: "foo @alice foo foo " })).toEqual({ from: 15, to: 18 })
  })

  it("normalises non-breaking and zero-width whitespace", () => {
    const doc = paragraph(text("alpha\u00A0beta\u200Bgamma"))
    expect(resolveSelectionRange(doc, { text: "beta gamma" })).toEqual({ from: 7, to: 17 })
  })

  it("returns null when the selection has no words or matches nothing", () => {
    const doc = paragraph(text("Hello world"))
    expect(resolveSelectionRange(doc, { text: "   " })).toBeNull()
    expect(resolveSelectionRange(doc, { text: "goodbye" })).toBeNull()
    expect(resolveSelectionRange({ type: "doc", content: [] }, { text: "anything" })).toBeNull()
  })
})
