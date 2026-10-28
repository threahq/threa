import { beforeEach, describe, expect, it } from "bun:test"
import type { JSONContent } from "@threahq/types"
import { ensureBlockIds } from "./block-ids"

let n = 0
const mint = () => `blk_${String(++n).padStart(26, "0")}`
const id = (value: number) => `blk_${String(value).padStart(26, "0")}`
const KEPT = "blk_01JABCDEFGHJKMNPQRSTVWXYZ0"

const text = (value: string): JSONContent => ({ type: "text", text: value })
const paragraph = (value: string, blockId?: unknown): JSONContent => ({
  type: "paragraph",
  ...(blockId === undefined ? {} : { attrs: { blockId } }),
  content: [text(value)],
})
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content })

beforeEach(() => {
  n = 100
})

describe("ensureBlockIds", () => {
  it("should mint ids only on block types at any depth and leave the input untouched", () => {
    const mentionParagraph: JSONContent = { type: "paragraph", content: [{ type: "mention", attrs: { id: "usr_1" } }] }
    const input = doc(
      {
        type: "bulletList",
        content: [{ type: "listItem", content: [{ type: "paragraph", attrs: { blockId: null } }] }],
      },
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [mentionParagraph] }] },
      { type: "agentBlock" },
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [mentionParagraph] }] }] }
    )
    const snapshot = structuredClone(input)

    expect({ result: ensureBlockIds(input, mint), input }).toEqual({
      result: doc(
        {
          type: "bulletList",
          attrs: { blockId: id(101) },
          content: [{ type: "listItem", content: [{ type: "paragraph", attrs: { blockId: id(102) } }] }],
        },
        {
          type: "taskList",
          attrs: { blockId: id(103) },
          content: [
            {
              type: "taskItem",
              attrs: { checked: true },
              content: [{ ...mentionParagraph, attrs: { blockId: id(104) } }],
            },
          ],
        },
        { type: "agentBlock", attrs: { blockId: id(105) } },
        {
          type: "table",
          attrs: { blockId: id(106) },
          content: [
            {
              type: "tableRow",
              content: [{ type: "tableCell", content: [{ ...mentionParagraph, attrs: { blockId: id(107) } }] }],
            },
          ],
        }
      ),
      input: snapshot,
    })
  })

  it("should keep valid ids and re-mint invalid ones", () => {
    const input = doc(
      paragraph("valid", KEPT),
      paragraph("short", "blk_kept"),
      paragraph("empty", ""),
      paragraph("number", 7),
      { type: "heading", attrs: { level: 1 } }
    )

    expect(ensureBlockIds(input, mint)).toEqual(
      doc(
        paragraph("valid", KEPT),
        paragraph("short", id(101)),
        paragraph("empty", id(102)),
        paragraph("number", id(103)),
        { type: "heading", attrs: { level: 1, blockId: id(104) } }
      )
    )
  })

  it("should re-mint a duplicated id and keep it on its first occurrence in document order", () => {
    const input = doc(
      paragraph("a", KEPT),
      { type: "blockquote", content: [paragraph("b", KEPT)] },
      paragraph("c", KEPT)
    )

    expect(ensureBlockIds(input, mint)).toEqual(
      doc(
        paragraph("a", KEPT),
        { type: "blockquote", attrs: { blockId: id(101) }, content: [paragraph("b", id(102))] },
        paragraph("c", id(103))
      )
    )
  })

  it("should return the same reference when every block already has a valid id", () => {
    const input = doc(paragraph("x", id(1)), { type: "horizontalRule", attrs: { blockId: id(2) } })

    expect(ensureBlockIds(input, mint)).toBe(input)
  })

  it("should not let a stray blockId on an inline node evict a block's id", () => {
    const input = doc({
      type: "paragraph",
      attrs: { blockId: KEPT },
      content: [{ type: "mention", attrs: { id: "usr_1", blockId: KEPT } }],
    })

    expect(ensureBlockIds(input, mint)).toBe(input)
  })

  it("should carry ids over from the previous revision to unchanged blocks and mint for changed ones", () => {
    const previous = doc(paragraph("one", id(1)), paragraph("two", id(2)), paragraph("three", id(3)))
    const incoming = doc(paragraph("one"), paragraph("two, edited"), paragraph("three"))

    expect(ensureBlockIds(incoming, mint, previous)).toEqual(
      doc(paragraph("one", id(1)), paragraph("two, edited", id(101)), paragraph("three", id(3)))
    )
  })

  it("should carry ids over when the previous revision's keys come back in a different order", () => {
    const previous = doc({ content: [text("one")], attrs: { blockId: id(1) }, type: "paragraph" })

    expect(ensureBlockIds(doc(paragraph("one")), mint, previous)).toEqual(doc(paragraph("one", id(1))))
  })

  it("should carry ids of identical previous blocks over in order", () => {
    const previous = doc(paragraph("same", id(1)), paragraph("same", id(2)))
    const incoming = doc(paragraph("same"), paragraph("same"), paragraph("same"))

    expect(ensureBlockIds(incoming, mint, previous)).toEqual(
      doc(paragraph("same", id(1)), paragraph("same", id(2)), paragraph("same", id(101)))
    )
  })

  it("should not carry over a previous id the incoming document already uses elsewhere", () => {
    const previous = doc(paragraph("one", id(1)), paragraph("two", id(2)))
    const incoming = doc(paragraph("one"), paragraph("moved", id(1)), paragraph("two"))

    expect(ensureBlockIds(incoming, mint, previous)).toEqual(
      doc(paragraph("one", id(101)), paragraph("moved", id(1)), paragraph("two", id(2)))
    )
  })
})
