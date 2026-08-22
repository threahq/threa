import { describe, expect, it } from "vitest"
import { getSchema } from "@tiptap/core"
import type { JSONContent } from "@tiptap/react"
import { CONTAINER_NODE_TYPES, LEAF_NODE_TYPES, docContentSize, sliceContent } from "@threa/prosemirror"
import { createEditorExtensions } from "./editor-extensions"

/**
 * `@threa/prosemirror` computes document positions from JSON alone, with no
 * schema — the backend and the workers have no editor to ask. This file is the
 * drift guard: it builds the real tiptap schema and proves the schema-less
 * numbers are the schema's numbers. It fails when an extension adds a node, or
 * turns a leaf into a container, without the shared sets following.
 */

const schema = getSchema(createEditorExtensions({ placeholder: "" }))

/** Wire-format alias for the editor's `slashCommand` node, accepted by the public API. */
const NON_SCHEMA_LEAF_TYPES = ["command"]

const fixture: JSONContent = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Release notes" }],
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Hello " },
        { type: "text", text: "brave", marks: [{ type: "bold" }] },
        { type: "text", text: " world, " },
        { type: "mention", attrs: { id: "usr_1", slug: "alice", mentionType: "user" } },
        { type: "text", text: " and " },
        { type: "channelLink", attrs: { id: "stream_1", slug: "general" } },
        { type: "hardBreak" },
        { type: "text", text: "run " },
        { type: "slashCommand", attrs: { name: "compact" } },
        { type: "emoji", attrs: { shortcode: "tada" } },
      ],
    },
    {
      type: "paragraph",
      content: [
        {
          type: "attachmentReference",
          attrs: {
            id: "att_1",
            filename: "spec.pdf",
            mimeType: "application/pdf",
            sizeBytes: 1024,
            status: "uploaded",
          },
        },
        { type: "memoEmbed", attrs: { memoId: "memo_1", title: "Decision" } },
        { type: "giphyEmbed", attrs: { giphyUrl: "https://media.giphy.com/media/abc/giphy.gif", title: "GIF" } },
        { type: "inAppLink", attrs: { url: "https://app.threa.io/streams/stream_1", name: "general" } },
      ],
    },
    {
      type: "bulletList",
      content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "first item" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "second item" }] }] },
      ],
    },
    {
      type: "orderedList",
      attrs: { start: 1 },
      content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "step one" }] }] }],
    },
    {
      type: "blockquote",
      content: [{ type: "paragraph", content: [{ type: "text", text: "quoted line" }] }, { type: "paragraph" }],
    },
    { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const a = 1\nconst b = 2" }] },
    { type: "horizontalRule" },
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "h1" }] }] },
            { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "h2" }] }] },
          ],
        },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "c1" }] }] },
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "c2" }] }] },
          ],
        },
      ],
    },
    {
      type: "quoteReply",
      attrs: {
        messageId: "msg_1",
        streamId: "stream_1",
        authorName: "Alice",
        authorId: "usr_1",
        actorType: "user",
        snippet: "quoted",
      },
    },
    {
      type: "sharedMessage",
      attrs: { messageId: "msg_2", streamId: "stream_2", authorName: "Bob", authorId: "usr_2", actorType: "user" },
    },
    { type: "paragraph" },
  ],
}

// Attrs come back from the schema with their defaults filled in, so comparing
// a slice to a `cut` compares content and not attribute normalisation.
const node = schema.nodeFromJSON(fixture)
const doc = node.toJSON() as JSONContent

describe("LEAF_NODE_TYPES", () => {
  it("holds exactly the leaf nodes of the real editor schema", () => {
    const schemaLeaves = Object.keys(schema.nodes)
      .filter((name) => schema.nodes[name].isLeaf)
      .sort()
    expect([...LEAF_NODE_TYPES].filter((name) => name in schema.nodes).sort()).toEqual(schemaLeaves)
    expect([...LEAF_NODE_TYPES].filter((name) => !(name in schema.nodes)).sort()).toEqual(NON_SCHEMA_LEAF_TYPES)
  })

  it("holds every non-leaf node of the real editor schema in the container set", () => {
    const schemaContainers = Object.keys(schema.nodes)
      .filter((name) => !schema.nodes[name].isLeaf)
      .sort()
    expect([...CONTAINER_NODE_TYPES].filter((name) => name in schema.nodes).sort()).toEqual(schemaContainers)
  })
})

describe("docContentSize", () => {
  it("matches the schema's own content size", () => {
    expect(docContentSize(doc)).toBe(node.content.size)
  })

  it("uses every node type the schema defines", () => {
    const used = new Set<string>()
    node.descendants((child) => {
      used.add(child.type.name)
      return true
    })
    expect([...Object.keys(schema.nodes)].filter((name) => name !== "doc" && !used.has(name))).toEqual([])
  })
})

describe("sliceContent", () => {
  const cut = (from: number, to: number): unknown => node.cut(from, to).toJSON()

  it.each([
    ["mid-word across a mark boundary", 18, 25],
    ["across an inline atom", 30, 40],
    ["across two list items", 60, 80],
    ["from a block leaf into the table after it", 143, 150],
    ["the whole document", 0, 178],
  ])("matches Node.cut for a range %s", (_name, from, to) => {
    expect(sliceContent(doc, from, to)).toEqual(cut(from, to))
  })

  it("reads the fixture as 178 positions, so the ranges above stay meaningful", () => {
    expect(node.content.size).toBe(178)
  })

  it("matches Node.cut for every range in the document", () => {
    const size = node.content.size
    const mismatches: Array<[number, number]> = []
    for (let from = 0; from <= size; from++) {
      for (let to = from; to <= size; to++) {
        if (JSON.stringify(sliceContent(doc, from, to)) !== JSON.stringify(cut(from, to))) {
          mismatches.push([from, to])
        }
      }
    }
    expect(mismatches).toEqual([])
  })
})
