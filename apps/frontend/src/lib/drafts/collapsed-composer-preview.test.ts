import { describe, expect, it } from "vitest"
import type { JSONContent } from "@threa/types"
import { createEditorExtensions } from "@/components/editor/editor-extensions"
import { collapsedComposerPreview } from "./collapsed-composer-preview"

const text = (value: string): JSONContent => ({ type: "text", text: value })
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content })
const listItem = (value: string): JSONContent => ({ type: "listItem", content: [paragraph(text(value))] })
const cell = (type: "tableHeader" | "tableCell", value: string): JSONContent => ({
  type,
  content: [paragraph(text(value))],
})
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content })

const hardBreakDoc = doc(paragraph(text("Before"), { type: "hardBreak" }, text("After")))

const NODE_CASES: Record<string, { content: JSONContent; expected: string }> = {
  doc: { content: doc(paragraph(text("Message"))), expected: "Message" },
  paragraph: { content: doc(paragraph(text("Message"))), expected: "Message" },
  text: { content: doc(paragraph(text("Message"))), expected: "Message" },
  hardBreak: { content: hardBreakDoc, expected: "Before…" },
  heading: { content: doc({ type: "heading", attrs: { level: 2 }, content: [text("Heading")] }), expected: "Heading" },
  bulletList: {
    content: doc({ type: "bulletList", content: [listItem("First"), listItem("Second")] }),
    expected: "First…",
  },
  orderedList: {
    content: doc({ type: "orderedList", content: [listItem("First"), listItem("Second")] }),
    expected: "First…",
  },
  listItem: {
    content: doc({ type: "listItem", content: [paragraph(text("First")), paragraph(text("Second"))] }),
    expected: "First…",
  },
  blockquote: {
    content: doc({ type: "blockquote", content: [paragraph(text("Quoted")), paragraph(text("More"))] }),
    expected: "Quoted…",
  },
  horizontalRule: { content: doc({ type: "horizontalRule" }), expected: "Divider" },
  codeBlock: {
    content: doc({
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [text("const first = 1\nconst second = 2")],
    }),
    expected: "const first = 1…",
  },
  table: {
    content: doc({
      type: "table",
      content: [
        { type: "tableRow", content: [cell("tableHeader", "Name"), cell("tableHeader", "Owner")] },
        { type: "tableRow", content: [cell("tableCell", "Composer"), cell("tableCell", "Ada")] },
      ],
    }),
    expected: "Table: Name…",
  },
  tableRow: {
    content: doc({ type: "tableRow", content: [cell("tableCell", "Name"), cell("tableCell", "Owner")] }),
    expected: "Name…",
  },
  tableHeader: {
    content: doc({ type: "tableHeader", content: [paragraph(text("Name")), paragraph(text("Details"))] }),
    expected: "Name…",
  },
  tableCell: {
    content: doc({ type: "tableCell", content: [paragraph(text("Name")), paragraph(text("Details"))] }),
    expected: "Name…",
  },
  attachmentReference: {
    content: doc(
      paragraph({
        type: "attachmentReference",
        attrs: {
          id: "att_1",
          filename: "spec.pdf",
          mimeType: "application/pdf",
          status: "uploaded",
          imageIndex: null,
        },
      })
    ),
    expected: "spec.pdf",
  },
  quoteReply: {
    content: doc({ type: "quoteReply", attrs: { authorName: "Ada", snippet: "Original" } }),
    expected: "Replying to Ada",
  },
  sharedMessage: {
    content: doc({ type: "sharedMessage", attrs: { authorName: "Bob" } }),
    expected: "Sharing message from Bob",
  },
  memoEmbed: {
    content: doc(paragraph({ type: "memoEmbed", attrs: { memoId: "memo_1", title: "Auth plan" } })),
    expected: "Memo: Auth plan",
  },
  inAppLink: {
    content: doc(paragraph({ type: "inAppLink", attrs: { name: "Design", url: "/w/ws/s/stream_1" } })),
    expected: "Design",
  },
  giphyEmbed: {
    content: doc(paragraph({ type: "giphyEmbed", attrs: { title: "happy cat", giphyUrl: "https://giphy.test/cat" } })),
    expected: "GIF: happy cat",
  },
  mention: {
    content: doc(paragraph({ type: "mention", attrs: { id: "usr_1", slug: "alice", mentionType: "user" } })),
    expected: "@alice",
  },
  channelLink: {
    content: doc(paragraph({ type: "channelLink", attrs: { id: "stream_1", slug: "general" } })),
    expected: "#general",
  },
  slashCommand: {
    content: doc(paragraph({ type: "slashCommand", attrs: { name: "steer", clientActionId: null } }, text(" focus"))),
    expected: "/steer focus",
  },
  emoji: {
    content: doc(paragraph({ type: "emoji", attrs: { shortcode: "rocket", emoji: "🚀" } })),
    expected: "🚀",
  },
}

function containsNodeType(node: JSONContent, type: string): boolean {
  return node.type === type || (node.content ?? []).some((child) => containsNodeType(child, type))
}

describe("collapsedComposerPreview", () => {
  it.each(Object.entries(NODE_CASES))("projects the %s editor node", (_type, testCase) => {
    expect(collapsedComposerPreview(testCase.content)).toBe(testCase.expected)
  })

  it("uses a real fixture for every matrix entry", () => {
    for (const [type, testCase] of Object.entries(NODE_CASES)) {
      expect(containsNodeType(testCase.content, type), `${type} fixture`).toBe(true)
    }
  })

  it("keeps the preview matrix aligned with every node in the composer schema", () => {
    const schemaNodeTypes = createEditorExtensions({ placeholder: "" })
      .filter((extension) => extension.type === "node")
      .map((extension) => extension.name)

    expect(new Set(schemaNodeTypes).size).toBe(schemaNodeTypes.length)
    expect(Object.keys(NODE_CASES).sort()).toEqual(schemaNodeTypes.sort())
  })

  it("skips empty leading lines without hiding later content", () => {
    expect(
      collapsedComposerPreview(
        doc(paragraph(text("  ")), paragraph({ type: "slashCommand", attrs: { name: "steer" } }), paragraph(text(" ")))
      )
    ).toBe("/steer")
    expect(collapsedComposerPreview(doc(paragraph({ type: "hardBreak" }, text("After"))))).toBe("After…")
    expect(collapsedComposerPreview(doc({ type: "codeBlock", content: [text("\nconst after = true")] }))).toBe(
      "const after = true…"
    )
  })

  it("names an unknown leaf instead of making a non-empty draft look empty", () => {
    expect(collapsedComposerPreview(doc({ type: "pollEmbed" }))).toBe("Poll embed")
  })
})
