import { describe, expect, it } from "vitest"
import { getThreaSchema } from "@threahq/prosemirror/schema"
import type { JSONContent } from "@threahq/types"
import { mediaRowColumns, mediaRowDecorations } from "./media-rows-extension"

function reference(id: string, mimeType: string, display: "inline" | "pill" = "inline"): JSONContent {
  return {
    type: "attachmentReference",
    attrs: {
      id,
      filename: `${id}.bin`,
      mimeType,
      sizeBytes: 1,
      status: "uploaded",
      imageIndex: null,
      error: null,
      display,
    },
  }
}

const space: JSONContent = { type: "text", text: " " }

/** The row width each attachment in the doc gets, keyed by attachment id. */
function columnsById(content: JSONContent[]): Record<string, number | null> {
  const doc = getThreaSchema().nodeFromJSON({ type: "doc", content })
  const decorations = mediaRowDecorations(doc)
  const result: Record<string, number | null> = {}
  doc.descendants((node, pos) => {
    if (node.type.name !== "attachmentReference") return
    result[node.attrs.id as string] = mediaRowColumns(decorations.find(pos, pos + node.nodeSize))
  })
  return result
}

describe("mediaRowDecorations", () => {
  it("should share a row between media separated by spaces and end it at text or a chip", () => {
    expect(
      columnsById([
        {
          type: "paragraph",
          content: [
            reference("a", "image/png"),
            space,
            reference("b", "video/mp4"),
            { type: "text", text: " caption " },
            reference("c", "image/png"),
            space,
            reference("d", "image/png", "pill"),
            space,
            reference("e", "application/pdf"),
          ],
        },
      ])
    ).toEqual({ a: 2, b: 2, c: 1, d: null, e: null })
  })

  it("should cap a long row at three across", () => {
    const run = ["a", "b", "c", "d"].flatMap((id) => [reference(id, "image/png"), space])
    expect(columnsById([{ type: "paragraph", content: run }])).toEqual({ a: 3, b: 3, c: 3, d: 3 })
  })

  it("should lay out media inside a table cell against that cell", () => {
    const cell = (content: JSONContent[]): JSONContent => ({
      type: "tableCell",
      content: [{ type: "paragraph", content }],
    })
    expect(
      columnsById([
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [cell([reference("a", "image/png")]), cell([reference("b", "image/png")])],
            },
          ],
        },
      ])
    ).toEqual({ a: 1, b: 1 })
  })
})
