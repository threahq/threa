import type { JSONContent } from "@threahq/types"

export const text = (value: string, marks?: JSONContent["marks"]): JSONContent => ({ type: "text", text: value, marks })
export const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content })
export const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content })

// Uses every node and mark of the editor schema; content-json-schema.test.ts
// fails when the schema grows past it.
export const everyNodeDoc = doc(
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
      attrs: { id: "attach_2", filename: "b.png", status: "uploaded", display: "inline" },
    },
    { type: "memoEmbed", attrs: { memoId: "memo_1", title: "Memo" } },
    { type: "docEmbed", attrs: { docId: "stream_2", blockId: "blk_1", title: "Doc" } },
    { type: "inAppLink", attrs: { url: "/w/x", streamId: "stream_1", name: "x" } },
    { type: "giphyEmbed", attrs: { giphyUrl: "https://giphy.com/x", width: 10, height: 10 } },
    { type: "math", attrs: { tex: "x", display: false } }
  ),
  { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("a"))] }] },
  { type: "orderedList", content: [{ type: "listItem", content: [paragraph(text("b"))] }] },
  {
    type: "taskList",
    content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph(text("done"))] }],
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
    attrs: {
      messageId: "msg_1",
      streamId: "stream_1",
      authorName: "Kris",
      authorId: "usr_1",
      actorType: "user",
      snippet: "quoted",
      version: 2,
      range: { from: 0, to: 3 },
    },
  },
  { type: "agentBlock", attrs: { authorId: "persona_1", authorName: "Ariadne" }, content: [paragraph(text("hi"))] },
  { type: "sharedMessage", attrs: { messageId: "msg_2", streamId: "stream_1" } }
)
