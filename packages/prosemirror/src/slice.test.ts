import { describe, expect, it } from "bun:test"
import type { JSONContent } from "@threahq/types"

import { isEmptySlice, isRangeValid, normalizeRange, sliceContent } from "./slice"

const mention: JSONContent = { type: "mention", attrs: { id: "usr_1", slug: "alice", mentionType: "user" } }

// Positions: paragraph one spans 0–13 ("Hello " at 1–6, "world" at 7–11),
// paragraph two spans 13–18 ("a" at 14, the mention at 15, "b" at 16).
const doc: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Hello " },
        { type: "text", text: "world", marks: [{ type: "bold" }] },
      ],
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: "a" }, mention, { type: "text", text: "b" }],
    },
  ],
}

describe("sliceContent", () => {
  it("cuts text on character boundaries and keeps marks", () => {
    expect(sliceContent(doc, 3, 9)).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "llo " },
            { type: "text", text: "wo", marks: [{ type: "bold" }] },
          ],
        },
      ],
    })
  })

  it("keeps the ancestors of a cut that spans two blocks", () => {
    expect(sliceContent(doc, 7, 16)).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "world", marks: [{ type: "bold" }] }] },
        { type: "paragraph", content: [{ type: "text", text: "a" }, mention] },
      ],
    })
  })

  it("keeps an atom whole and drops one the range only touches", () => {
    expect(sliceContent(doc, 15, 16)).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [mention] }],
    })
    expect(sliceContent(doc, 16, 17)).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }],
    })
  })

  it("leaves an emptied container behind, as ProseMirror does", () => {
    expect(sliceContent(doc, 13, 14)).toEqual({ type: "doc", content: [{ type: "paragraph" }] })
  })

  it("returns the document itself for a whole-document range", () => {
    expect(sliceContent(doc, 0, 18)).toEqual(doc)
  })

  it("returns an empty document for an empty range", () => {
    expect(sliceContent(doc, 5, 5)).toEqual({ type: "doc" })
  })
})

describe("isRangeValid", () => {
  it("accepts a non-empty in-bounds integer range", () => {
    expect(isRangeValid(doc, { from: 0, to: 18 })).toBe(true)
    expect(isRangeValid(doc, { from: 3, to: 9 })).toBe(true)
  })

  it("rejects reversed, empty, out-of-bounds and non-integer ranges", () => {
    expect(isRangeValid(doc, { from: 9, to: 3 })).toBe(false)
    expect(isRangeValid(doc, { from: 3, to: 3 })).toBe(false)
    expect(isRangeValid(doc, { from: -1, to: 5 })).toBe(false)
    expect(isRangeValid(doc, { from: 0, to: 19 })).toBe(false)
    expect(isRangeValid(doc, { from: 0.5, to: 5 })).toBe(false)
  })
})

describe("normalizeRange", () => {
  it("collapses a whole-document range and an absent range to null", () => {
    expect(normalizeRange(doc, { from: 0, to: 18 })).toBeNull()
    expect(normalizeRange(doc, null)).toBeNull()
    expect(normalizeRange(doc, undefined)).toBeNull()
  })

  it("passes a partial range through", () => {
    expect(normalizeRange(doc, { from: 3, to: 9 })).toEqual({ from: 3, to: 9 })
  })
})

describe("isEmptySlice", () => {
  it("is false for a slice with visible text or an atom", () => {
    expect(isEmptySlice(sliceContent(doc, 3, 9))).toBe(false)
    expect(isEmptySlice(sliceContent(doc, 15, 16))).toBe(false)
  })

  it("is true for a slice with no atoms and no non-whitespace text", () => {
    expect(isEmptySlice({ type: "doc", content: [{ type: "paragraph" }] })).toBe(true)
    expect(
      isEmptySlice({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "  " }] }] })
    ).toBe(true)
    expect(isEmptySlice({ type: "doc", content: [{ type: "paragraph", content: [{ type: "hardBreak" }] }] })).toBe(true)
  })
})
