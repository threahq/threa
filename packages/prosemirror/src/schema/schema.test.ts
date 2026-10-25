import { describe, expect, test } from "bun:test"
import type { JSONContent } from "@tiptap/core"
import { parseMarkdown } from "../markdown"
import { threaDocumentSchema } from "@threahq/types"
import { BLOCK_ID_NODE_TYPES } from "./attributes"
import { getThreaSchema, InvalidContentError, normalizeContentJson } from "./index"

const text = (value: string, marks?: JSONContent["marks"]): JSONContent => ({ type: "text", text: value, marks })
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content })
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content })

describe("threa schema", () => {
  test("should build the schema when no DOM globals exist", () => {
    expect([typeof document, typeof window]).toEqual(["undefined", "undefined"])
    expect(getThreaSchema().topNodeType.name).toBe("doc")
  })

  test("should expose the pinned node and mark sets when built", () => {
    const schema = getThreaSchema()
    expect(Object.keys(schema.nodes).sort()).toEqual([
      "agentBlock",
      "attachmentReference",
      "blockquote",
      "bulletList",
      "channelLink",
      "codeBlock",
      "doc",
      "emoji",
      "giphyEmbed",
      "hardBreak",
      "heading",
      "horizontalRule",
      "inAppLink",
      "listItem",
      "math",
      "memoEmbed",
      "mention",
      "orderedList",
      "paragraph",
      "quoteReply",
      "sharedMessage",
      "slashCommand",
      "table",
      "tableCell",
      "tableHeader",
      "tableRow",
      "taskItem",
      "taskList",
      "text",
    ])
    expect(Object.keys(schema.marks).sort()).toEqual(["bold", "code", "italic", "link", "strike"])
  })

  test("should validate when a document contains every node and mark type", () => {
    const fixture = doc(
      { type: "heading", attrs: { level: 2 }, content: [text("Title")] },
      paragraph(
        text("bold", [{ type: "bold" }, { type: "italic" }, { type: "strike" }]),
        text("code", [{ type: "code" }]),
        text("link", [{ type: "link", attrs: { href: "https://example.com" } }]),
        { type: "hardBreak" },
        { type: "mention", attrs: { id: "usr_1", slug: "kris", mentionType: "user" } },
        { type: "channelLink", attrs: { id: "stream_1", slug: "general" } },
        { type: "slashCommand", attrs: { name: "invite" } },
        { type: "emoji", attrs: { shortcode: "smile", emoji: "😄" } },
        { type: "attachmentReference", attrs: { id: "attach_1", filename: "a.pdf", status: "uploaded" } },
        {
          type: "attachmentReference",
          attrs: { id: "attach_2", filename: "a.png", mimeType: "image/png", status: "uploaded", display: "inline" },
        },
        { type: "memoEmbed", attrs: { memoId: "memo_1", title: "Memo" } },
        { type: "inAppLink", attrs: { url: "/w/x", streamId: "stream_1", name: "x" } },
        { type: "giphyEmbed", attrs: { giphyUrl: "https://giphy.com/x", width: 10, height: 10 } },
        { type: "math", attrs: { tex: "x", display: false } }
      ),
      { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("a"))] }] },
      { type: "orderedList", content: [{ type: "listItem", content: [paragraph(text("b"))] }] },
      {
        type: "taskList",
        content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph(text("t"))] }],
      },
      { type: "blockquote", content: [paragraph(text("q"))] },
      { type: "horizontalRule" },
      { type: "codeBlock", attrs: { language: "ts" }, content: [text("const x = 1")] },
      {
        type: "table",
        content: [
          { type: "tableRow", content: [{ type: "tableHeader", content: [paragraph(text("h"))] }] },
          { type: "tableRow", content: [{ type: "tableCell", content: [paragraph(text("c"))] }] },
        ],
      },
      {
        type: "quoteReply",
        attrs: { messageId: "msg_1", streamId: "stream_1", version: 2, range: { from: 0, to: 3 } },
      },
      { type: "agentBlock", attrs: { authorId: "persona_1", authorName: "Ariadne" }, content: [paragraph(text("hi"))] },
      { type: "sharedMessage", attrs: { messageId: "msg_2", streamId: "stream_1" } }
    )
    const schema = getThreaSchema()
    const usedNodes = new Set(["doc"])
    const usedMarks = new Set<string>()
    schema.nodeFromJSON(fixture).descendants((child) => {
      usedNodes.add(child.type.name)
      for (const mark of child.marks) usedMarks.add(mark.type.name)
    })

    expect(() => normalizeContentJson(fixture)).not.toThrow()
    expect({ nodes: [...usedNodes].sort(), marks: [...usedMarks].sort() }).toEqual({
      nodes: Object.keys(schema.nodes).sort(),
      marks: Object.keys(schema.marks).sort(),
    })
  })

  test.each([
    ["an unknown node type", doc({ type: "widget" }), "Unknown node type: widget"],
    ["a paragraph nests in a paragraph", doc(paragraph(paragraph(text("x")))), "Invalid content for node paragraph"],
    ["a text node has an unknown mark", doc(paragraph(text("x", [{ type: "underline" }]))), "underline"],
    ["a text node sits at the top level", doc(text("x")), "Invalid content for node doc"],
    [
      "a link href is not a string",
      doc(paragraph(text("x", [{ type: "link", attrs: { href: { url: "https://example.com" } } }]))),
      "for attribute href on type link",
    ],
  ])("should throw InvalidContentError naming the culprit when %s", (_label, json, message) => {
    expect(() => normalizeContentJson(json)).toThrow(InvalidContentError)
    expect(() => normalizeContentJson(json)).toThrow(message)
  })

  test("should fill attachmentReference defaults when its attrs are omitted", () => {
    const json = doc(paragraph({ type: "attachmentReference" }))

    expect(() => normalizeContentJson(json)).not.toThrow()
    expect(getThreaSchema().nodeFromJSON(json).toJSON()).toEqual(
      doc({
        type: "paragraph",
        attrs: { blockId: null },
        content: [
          {
            type: "attachmentReference",
            attrs: {
              id: null,
              filename: "",
              mimeType: "application/octet-stream",
              sizeBytes: null,
              status: "uploading",
              imageIndex: null,
              error: null,
              display: "pill",
            },
          },
        ],
      })
    )
  })

  test("should drop a blockId when it sits on an inline node", () => {
    const json = doc(paragraph({ type: "mention", attrs: { id: "usr_1", slug: "a", blockId: "blk_1" } }))

    expect(normalizeContentJson(json)).toEqual(
      doc({
        type: "paragraph",
        attrs: { blockId: null },
        content: [{ type: "mention", attrs: { id: "usr_1", slug: "a", mentionType: "user" } }],
      })
    )
  })

  test("should accept a checked task item when it nests a bullet list", () => {
    const nested = { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("b"))] }] }
    const json = doc({
      type: "taskList",
      content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph(text("a")), nested] }],
    })

    expect(() => normalizeContentJson(json)).not.toThrow()
  })

  test("should keep a paragraph blockId and fill null when it is absent", () => {
    const json = doc({ type: "paragraph", attrs: { blockId: "blk_1" }, content: [text("a")] }, paragraph(text("b")))

    expect(normalizeContentJson(json)).toEqual(
      doc(
        { type: "paragraph", attrs: { blockId: "blk_1" }, content: [text("a")] },
        { type: "paragraph", attrs: { blockId: null }, content: [text("b")] }
      )
    )
  })

  test("should default codeBlock language to plaintext when it is omitted", () => {
    const json = doc({ type: "codeBlock", content: [text("x")] })

    expect(getThreaSchema().nodeFromJSON(json).toJSON()).toEqual(
      doc({ type: "codeBlock", attrs: { language: "plaintext", blockId: null }, content: [text("x")] })
    )
  })

  test.each([
    "# One\n\n## Two\n\n### Three",
    "- a\n- b\n\n1. one\n2. two",
    "- [ ] a\n- [x] b",
    "| h1 | h2 |\n| --- | --- |\n| a | b |",
    "```ts\nconst x = 1\n```",
    "see [docs](https://example.com)",
    "inline $x$ math",
    "hi [@kris](user:usr_1)",
    "in [#general](channel:stream_1)",
    '[report.pdf](attachment:attach_123 "threa-attachment:filename=report.pdf&mimeType=application%2Fpdf&sizeBytes=2048")',
    "**`bold code`** and [`linked code`](https://example.com) and *`x`* and ~~`y`~~",
  ])("should validate parseMarkdown output when given %s", (markdown) => {
    expect(() => normalizeContentJson(parseMarkdown(markdown))).not.toThrow()
  })
})

describe("block id attribute coverage", () => {
  const BLOCK_ID = `blk_${"0".repeat(26)}`
  const body = [paragraph(text("x"))]
  const reference = { messageId: "msg_1", streamId: "stream_1" }
  // The persistence schema has no table node, so only the editor schema covers it.
  const minimalNodes: Record<string, JSONContent> = {
    paragraph: paragraph(text("x")),
    heading: { type: "heading", attrs: { level: 1 }, content: [text("x")] },
    bulletList: { type: "bulletList", content: [{ type: "listItem", content: body }] },
    orderedList: { type: "orderedList", content: [{ type: "listItem", content: body }] },
    taskList: { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: body }] },
    blockquote: { type: "blockquote", content: body },
    codeBlock: { type: "codeBlock", content: [text("x")] },
    horizontalRule: { type: "horizontalRule" },
    agentBlock: { type: "agentBlock", attrs: { authorId: "persona_1", authorName: "Ariadne" }, content: body },
    quoteReply: {
      type: "quoteReply",
      attrs: { ...reference, authorName: "Alice", authorId: "usr_1", actorType: "user", snippet: "hi" },
    },
    sharedMessage: { type: "sharedMessage", attrs: reference },
  }

  test("should list every block-group node of the editor schema in BLOCK_ID_NODE_TYPES", () => {
    const blockNodes = Object.values(getThreaSchema().nodes)
      .filter((node) => (node.spec.group ?? "").split(" ").includes("block"))
      .map((node) => node.name)

    expect(blockNodes.sort()).toEqual([...BLOCK_ID_NODE_TYPES].sort())
  })

  test("should keep a block id through persistence validation on every block type", () => {
    const withId = (node: JSONContent): JSONContent => ({ ...node, attrs: { ...node.attrs, blockId: BLOCK_ID } })
    const kept = Object.fromEntries(
      Object.entries(minimalNodes).map(([type, node]) => {
        const parsed = threaDocumentSchema.parse(doc(withId(node))) as JSONContent
        return [type, parsed.content?.[0]?.attrs?.blockId]
      })
    )

    expect(kept).toEqual(
      Object.fromEntries(BLOCK_ID_NODE_TYPES.filter((type) => type !== "table").map((type) => [type, BLOCK_ID]))
    )
  })
})
