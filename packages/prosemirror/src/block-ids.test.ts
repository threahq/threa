import { describe, expect, it } from "bun:test"
import type { JSONContent } from "@threahq/types"
import { ensureBlockIds } from "./block-ids"

const BLOCK_ID = /^blk_[0-9A-HJKMNP-TV-Z]{26}$/

describe("ensureBlockIds", () => {
  it("should mint ids only on block types when they are missing at any depth", () => {
    const input: JSONContent = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [{ type: "paragraph", attrs: { blockId: null } }] }],
        },
      ],
    }
    const snapshot = structuredClone(input)

    const result = ensureBlockIds(input)
    const list = result.content![0]
    const listItem = list.content![0]
    const paragraph = listItem.content![0]

    expect({
      list: BLOCK_ID.test(String(list.attrs?.blockId)),
      listItemAttrs: listItem.attrs,
      paragraph: BLOCK_ID.test(String(paragraph.attrs?.blockId)),
      distinct: list.attrs?.blockId !== paragraph.attrs?.blockId,
      inputUnchanged: input,
    }).toEqual({ list: true, listItemAttrs: undefined, paragraph: true, distinct: true, inputUnchanged: snapshot })
  })

  it("should keep existing ids when some are present", () => {
    const input: JSONContent = {
      type: "doc",
      content: [
        { type: "paragraph", attrs: { blockId: "blk_kept" } },
        { type: "heading", attrs: { level: 1 } },
      ],
    }

    const result = ensureBlockIds(input)

    expect({
      kept: result.content![0],
      minted: BLOCK_ID.test(String(result.content![1].attrs?.blockId)),
      level: result.content![1].attrs?.level,
    }).toEqual({
      kept: { type: "paragraph", attrs: { blockId: "blk_kept" } },
      minted: true,
      level: 1,
    })
  })

  it("should re-mint a repeated id so every block id is unique within the document", () => {
    const input: JSONContent = {
      type: "doc",
      content: [
        { type: "paragraph", attrs: { blockId: "blk_dup" } },
        { type: "paragraph", attrs: { blockId: "blk_dup" } },
        { type: "blockquote", content: [{ type: "paragraph", attrs: { blockId: "blk_dup" } }] },
      ],
    }

    const result = ensureBlockIds(input)
    const [first, second, quote] = result.content!
    const nested = quote.content![0]

    expect({
      first: first.attrs?.blockId,
      secondMinted: BLOCK_ID.test(String(second.attrs?.blockId)),
      nestedMinted: BLOCK_ID.test(String(nested.attrs?.blockId)),
      distinct: second.attrs?.blockId !== nested.attrs?.blockId,
    }).toEqual({ first: "blk_dup", secondMinted: true, nestedMinted: true, distinct: true })
  })

  it("should return the same reference when every block already has an id", () => {
    const input: JSONContent = {
      type: "doc",
      content: [
        { type: "paragraph", attrs: { blockId: "blk_a" }, content: [{ type: "text", text: "x" }] },
        { type: "horizontalRule", attrs: { blockId: "blk_b" } },
      ],
    }

    expect(ensureBlockIds(input)).toBe(input)
  })

  it("should mint ids on paragraphs nested in tasks, quotes, agent blocks and cells but not on inline or wrapper nodes", () => {
    const paragraph: JSONContent = { type: "paragraph", content: [{ type: "mention", attrs: { id: "usr_1" } }] }
    const input: JSONContent = {
      type: "doc",
      content: [
        { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph] }] },
        { type: "blockquote", content: [paragraph] },
        { type: "agentBlock" },
        {
          type: "table",
          content: [{ type: "tableRow", content: [{ type: "tableCell", content: [paragraph] }] }],
        },
      ],
    }
    const ids = (node: JSONContent): string[] => [
      ...(typeof node.attrs?.blockId === "string" && BLOCK_ID.test(node.attrs.blockId) ? [node.type!] : []),
      ...(node.content ?? []).flatMap(ids),
    ]

    expect(ids(ensureBlockIds(input))).toEqual([
      "taskList",
      "paragraph",
      "blockquote",
      "paragraph",
      "agentBlock",
      "table",
      "paragraph",
    ])
  })
})
