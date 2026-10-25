import { describe, expect, it } from "bun:test"
import type { JSONContent } from "@threahq/types"
import { parseMarkdown } from "@threahq/prosemirror"
import { getThreaSchema } from "@threahq/prosemirror/schema"
import { deriveContentMarkdown } from "./content"
import { contentJsonSchema } from "./content-json-schema"
import { doc, everyNodeDoc, paragraph, text } from "./content-json-fixtures"

const invalidDocs = [
  ["an unknown node type", doc({ type: "widget" }), "Unknown node type: widget"],
  ["a text node sits at the doc top level", doc(text("x")), "Invalid content for node doc"],
  ["a text run has an unknown mark", doc(paragraph(text("x", [{ type: "underline" }]))), "underline"],
] as const

function collectTypes(node: JSONContent, into = { nodes: new Set<string>(), marks: new Set<string>() }) {
  if (node.type) into.nodes.add(node.type)
  for (const mark of node.marks ?? []) into.marks.add(mark.type)
  for (const child of node.content ?? []) collectTypes(child, into)
  return into
}

describe("contentJsonSchema", () => {
  it.each(invalidDocs)("should reject when the doc has %s", (_label, json, message) => {
    const result = contentJsonSchema.safeParse(json)

    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: [], message: expect.stringContaining(message) }),
    ])
  })

  it("should accept markdown that wraps code in bold", () => {
    const result = contentJsonSchema.safeParse(parseMarkdown("**`x`**"))

    expect(result.success).toBe(true)
  })

  it("should fill attribute defaults so the stored doc serializes when a node arrives without attrs", () => {
    const result = contentJsonSchema.safeParse(doc({ type: "quoteReply" }, { type: "sharedMessage" }))

    expect({ success: result.success, markdown: result.success ? deriveContentMarkdown(result.data) : null }).toEqual({
      success: true,
      markdown: expect.any(String),
    })
  })

  it("should accept when the doc uses every node and mark type", () => {
    const result = contentJsonSchema.safeParse(everyNodeDoc)

    expect(result.success).toBe(true)
  })

  it("should cover every node and mark of the editor schema when the fixture is checked against it", () => {
    const schema = getThreaSchema()

    const used = collectTypes(everyNodeDoc)

    expect({ nodes: [...used.nodes].sort(), marks: [...used.marks].sort() }).toEqual({
      nodes: Object.keys(schema.nodes).sort(),
      marks: Object.keys(schema.marks).sort(),
    })
  })
})
