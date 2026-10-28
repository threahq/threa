import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import type { JSONContent } from "@tiptap/react"
import { createEditorExtensions } from "./editor-extensions"
import { linksToShares, sharesToLinks } from "./reference-conversions"
import { buildMessageLink, buildStreamLink } from "@/lib/stream-links"
import { referenceKeyOf } from "@/lib/reference-audience"

const WS = "ws_1"

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

const docContent = (editor: Editor) => (editor.getJSON().content ?? []) as JSONContent[]

function createEditor(content: JSONContent[]): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: createEditorExtensions({ placeholder: "" }),
    content: { type: "doc", content },
  })
  editors.push(editor)
  return editor
}

const text = (value: string): JSONContent => ({ type: "text", text: value })
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", attrs: { blockId: null }, content })

function chip(streamId: string, messageId: string | null): JSONContent {
  const url = messageId ? buildMessageLink(WS, streamId, messageId) : buildStreamLink(WS, streamId)
  return { type: "inAppLink", attrs: { url, streamId, messageId, name: "" } }
}

const list = (...items: JSONContent[]): JSONContent => ({
  type: "bulletList",
  attrs: { blockId: null },
  content: items.map((item) => ({ type: "listItem", content: [item] })),
})

const share = (streamId: string, messageId: string): JSONContent => ({
  type: "sharedMessage",
  attrs: { streamId, messageId },
})

const quote = (streamId: string, messageId: string): JSONContent => ({
  type: "quoteReply",
  attrs: { streamId, messageId, authorName: "Ada", authorId: "usr_a", actorType: "user", snippet: "hi" },
})

function sharedAttrs(streamId: string, messageId: string) {
  return {
    type: "sharedMessage",
    attrs: {
      streamId,
      messageId,
      authorName: "",
      authorId: "",
      actorType: "user",
      conversationId: null,
      version: null,
      range: null,
      blockId: null,
    },
  }
}

describe("linksToShares", () => {
  it("splits the sentence around a message chip from a listed stream", () => {
    const editor = createEditor([paragraph(text("see "), chip("stream_a", "msg_1"), text(" please"))])
    linksToShares(editor, ["stream_a"])
    expect(docContent(editor)).toEqual([
      paragraph(text("see ")),
      sharedAttrs("stream_a", "msg_1"),
      paragraph(text(" please")),
    ])
  })

  it("moves shares for links nested in a list or quote after the outer block, in order", () => {
    const editor = createEditor([
      list(paragraph(text("x "), chip("stream_a", "msg_1")), paragraph(chip("stream_a", "msg_2"), text(" y"))),
      { type: "blockquote", attrs: { blockId: null }, content: [paragraph(text("q "), chip("stream_a", "msg_3"))] },
    ])
    linksToShares(editor, ["stream_a"])
    expect(docContent(editor)).toEqual([
      list(paragraph(text("x ")), paragraph(text(" y"))),
      sharedAttrs("stream_a", "msg_1"),
      sharedAttrs("stream_a", "msg_2"),
      { type: "blockquote", attrs: { blockId: null }, content: [paragraph(text("q "))] },
      sharedAttrs("stream_a", "msg_3"),
    ])
  })

  it("drops a list item a chip filled, and replaces a quote a chip filled with the share in place", () => {
    const editor = createEditor([
      list(paragraph(chip("stream_a", "msg_1")), paragraph(text("kept"))),
      { type: "blockquote", attrs: { blockId: null }, content: [paragraph(chip("stream_a", "msg_2"))] },
      paragraph(text("end")),
    ])
    linksToShares(editor, ["stream_a"])
    expect(docContent(editor)).toEqual([
      list(paragraph(text("kept"))),
      sharedAttrs("stream_a", "msg_1"),
      sharedAttrs("stream_a", "msg_2"),
      paragraph(text("end")),
    ])
  })

  it("drops a list item two chips filled together, keeping both shares in order", () => {
    const editor = createEditor([
      list(paragraph(text("kept")), paragraph(chip("stream_a", "msg_1"), chip("stream_a", "msg_2"))),
    ])
    linksToShares(editor, ["stream_a"])
    expect(docContent(editor)).toEqual([
      list(paragraph(text("kept"))),
      sharedAttrs("stream_a", "msg_1"),
      sharedAttrs("stream_a", "msg_2"),
    ])
  })

  it("keeps the paragraph a list item requires when a chip filled it above a nested list", () => {
    const nested = list(paragraph(text("child")))
    const editor = createEditor([
      { type: "bulletList", content: [{ type: "listItem", content: [paragraph(chip("stream_a", "msg_1")), nested] }] },
    ])
    linksToShares(editor, ["stream_a"])
    expect(docContent(editor)).toEqual([
      {
        type: "bulletList",
        attrs: { blockId: null },
        content: [{ type: "listItem", content: [{ type: "paragraph", attrs: { blockId: null } }, nested] }],
      },
      sharedAttrs("stream_a", "msg_1"),
    ])
  })

  it("converts link-marked message text and leaves other streams and stream-only links alone", () => {
    const href = buildMessageLink(WS, "stream_a", "msg_2")
    const editor = createEditor([
      paragraph(
        text("a "),
        { type: "text", text: "this", marks: [{ type: "link", attrs: { href } }] },
        text(" b "),
        chip("stream_b", "msg_3"),
        text(" c "),
        chip("stream_a", null)
      ),
    ])
    linksToShares(editor, ["stream_a"])
    const [before, converted, after] = docContent(editor)
    expect({
      before: before.content?.map((node) => node.text),
      converted,
      after: after.content?.map((node) => (node.type === "inAppLink" ? node.attrs?.streamId : node.text)),
    }).toEqual({
      before: ["a "],
      converted: sharedAttrs("stream_a", "msg_2"),
      after: [" b ", "stream_b", " c ", "stream_a"],
    })
  })
})

describe("sharesToLinks", () => {
  it("turns listed shares and quotes into copy-link chips and keeps the rest", () => {
    const editor = createEditor([
      paragraph(text("intro")),
      share("stream_a", "msg_1"),
      quote("stream_a", "msg_2"),
      share("stream_b", "msg_3"),
    ])
    sharesToLinks(editor, WS, ["stream_a"])
    const content = docContent(editor)
    expect({
      types: content.map((node) => node.type),
      links: content.flatMap((node) => node.content?.filter((child) => child.type === "inAppLink") ?? []),
    }).toEqual({
      types: ["paragraph", "paragraph", "paragraph", "sharedMessage"],
      links: [
        {
          type: "inAppLink",
          attrs: { url: buildMessageLink(WS, "stream_a", "msg_1"), streamId: "stream_a", messageId: "msg_1", name: "" },
        },
        {
          type: "inAppLink",
          attrs: { url: buildMessageLink(WS, "stream_a", "msg_2"), streamId: "stream_a", messageId: "msg_2", name: "" },
        },
      ],
    })
  })

  it("leaves shares an edit already sent alone", () => {
    const editor = createEditor([share("stream_a", "msg_1"), share("stream_a", "msg_2")])
    sharesToLinks(
      editor,
      WS,
      ["stream_a"],
      new Set([referenceKeyOf({ kind: "share", streamId: "stream_a", messageId: "msg_1" })])
    )
    expect(docContent(editor).map((node) => node.type)).toEqual(["sharedMessage", "paragraph"])
  })
})
