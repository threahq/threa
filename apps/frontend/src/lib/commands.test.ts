import { describe, it, expect } from "vitest"
import type { JSONContent } from "@threahq/types"
import {
  extractCommandNode,
  extractCommandFromRawText,
  extractEnqueueDirective,
  withEnqueueDirective,
  commandDoc,
} from "./commands"

describe("extractCommandNode", () => {
  it("extracts name + clientActionId from the first slashCommand node", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "slashCommand",
              attrs: { name: "aside", clientActionId: "aside" },
            },
          ],
        },
      ],
    }
    expect(extractCommandNode(doc)).toEqual({
      name: "aside",
      clientActionId: "aside",
    })
  })

  it("returns clientActionId: null for regular server commands", () => {
    // `CommandExtension` defaults `clientActionId` to null for server commands
    // so the composer's client-action branch is opt-in, not accidental.
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "slashCommand",
              attrs: { name: "invite", clientActionId: null },
              content: [{ type: "text", text: " @alice" }],
            },
          ],
        },
      ],
    }
    expect(extractCommandNode(doc)).toEqual({ name: "invite", clientActionId: null })
  })

  it("returns null when no slashCommand node is present", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
    }
    expect(extractCommandNode(doc)).toBeNull()
  })

  it("extracts a slashCommand node even when followed by trailing whitespace", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "slashCommand", attrs: { name: "model", clientActionId: null } },
            { type: "text", text: " " },
          ],
        },
      ],
    }
    expect(extractCommandNode(doc)).toEqual({ name: "model", clientActionId: null })
  })

  it("returns null for plain text that starts with a slash (no materialized node)", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "/s" }] }],
    }
    expect(extractCommandNode(doc)).toBeNull()
  })

  it("returns null for an empty paragraph", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph" }],
    }
    expect(extractCommandNode(doc)).toBeNull()
  })

  it("returns null for content with mentions, channels, or emojis but no command", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: "user_1", slug: "alice", mentionType: "user" } },
            { type: "text", text: " look " },
            { type: "channelLink", attrs: { id: "stream_1", slug: "general" } },
            { type: "text", text: " " },
            { type: "emoji", attrs: { shortcode: "tada" } },
          ],
        },
      ],
    }
    expect(extractCommandNode(doc)).toBeNull()
  })

  it("returns null when attrs.name is missing or non-string", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "slashCommand", attrs: {} }] }],
    }
    expect(extractCommandNode(doc)).toBeNull()
  })

  it("detects a slashCommand nested after other inline content", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "prefix " },
            { type: "slashCommand", attrs: { name: "help", clientActionId: null } },
          ],
        },
      ],
    }
    expect(extractCommandNode(doc)?.name).toBe("help")
  })
})

const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content })
const text = (value: string, marks?: JSONContent["marks"]): JSONContent => ({ type: "text", text: value, marks })
const enqueueNode: JSONContent = { type: "slashCommand", attrs: { name: "enqueue", clientActionId: null } }
const docOf = (...content: JSONContent[]): JSONContent => ({ type: "doc", content })

describe("extractEnqueueDirective", () => {
  const typed = { typed: true }

  it.each([
    {
      name: "a picked command node at the start",
      input: docOf(paragraph(enqueueNode, text(" fix the tests"))),
      expected: docOf(paragraph(text("fix the tests"))),
    },
    {
      name: "a picked command node mid-sentence",
      input: docOf(paragraph(text("fix the tests "), enqueueNode, text(" after this"))),
      expected: docOf(paragraph(text("fix the tests "), text("after this"))),
    },
    {
      name: "a picked command node at the end",
      input: docOf(paragraph(text("fix the tests "), enqueueNode)),
      expected: docOf(paragraph(text("fix the tests"))),
    },
    {
      name: "typed tokens at the end, the middle, and in a later paragraph",
      input: docOf(paragraph(text("I want option 2 /enqueue")), paragraph(text("Yes. /ENQUEUE and also pizza"))),
      expected: docOf(paragraph(text("I want option 2")), paragraph(text("Yes. and also pizza"))),
    },
    {
      name: "repeated typed tokens",
      input: docOf(paragraph(text("/enqueue /enqueue fix it /enqueue /enqueue"))),
      expected: docOf(paragraph(text("fix it"))),
    },
    {
      name: "a formatted token between spaces",
      input: docOf(paragraph(text("fix "), text("/enqueue", [{ type: "italic" }]), text(" later"))),
      expected: docOf(paragraph(text("fix "), text("later"))),
    },
    {
      name: "a paragraph holding only the directive",
      input: docOf(paragraph(text("/enqueue")), paragraph(text("fix the tests"))),
      expected: docOf(paragraph(text("fix the tests"))),
    },
    {
      name: "a typed token inside a list item",
      input: docOf({
        type: "bulletList",
        content: [{ type: "listItem", content: [paragraph(text("/enqueue start with tests"))] }],
      }),
      expected: docOf({
        type: "bulletList",
        content: [{ type: "listItem", content: [paragraph(text("start with tests"))] }],
      }),
    },
    {
      name: "a list item holding only the directive",
      input: docOf({
        type: "bulletList",
        content: [
          { type: "listItem", content: [paragraph(enqueueNode)] },
          { type: "listItem", content: [paragraph(text("start with tests"))] },
        ],
      }),
      expected: docOf({
        type: "bulletList",
        content: [{ type: "listItem", content: [paragraph(text("start with tests"))] }],
      }),
    },
    {
      name: "a quote holding only the directive",
      input: docOf({ type: "blockquote", content: [paragraph(text("/enqueue"))] }, paragraph(text("fix the tests"))),
      expected: docOf(paragraph(text("fix the tests"))),
    },
    {
      name: "a picked command node glued between two words",
      input: docOf(paragraph(text("fix"), enqueueNode, text("later"))),
      expected: docOf(paragraph(text("fix"), text(" later"))),
    },
  ])("should strip $name and keep the message", ({ input, expected }) => {
    expect(extractEnqueueDirective(input, typed)).toEqual({ kind: "enqueue-message", content: expected })
  })

  it("should report no message when the directive is all there is", () => {
    const emptyList = docOf({ type: "bulletList", content: [{ type: "listItem", content: [paragraph(enqueueNode)] }] })
    expect({
      typed: extractEnqueueDirective(docOf(paragraph(text("/enqueue")), { type: "paragraph" }), typed),
      picked: extractEnqueueDirective(docOf(paragraph(enqueueNode, text(" "))), typed),
      list: extractEnqueueDirective(emptyList, typed),
    }).toEqual({ typed: { kind: "empty-enqueue" }, picked: { kind: "empty-enqueue" }, list: { kind: "empty-enqueue" } })
  })

  it("should keep an attachment as message content", () => {
    const attachment: JSONContent = { type: "attachmentReference", attrs: { id: "att_1", filename: "image.png" } }
    expect(extractEnqueueDirective(docOf(paragraph(attachment, text(" /enqueue"))), typed)).toEqual({
      kind: "enqueue-message",
      content: docOf(paragraph(attachment)),
    })
  })

  it("should take only a picked node when typed tokens are off", () => {
    expect({
      picked: extractEnqueueDirective(docOf(paragraph(enqueueNode, text(" fix /enqueue it"))), { typed: false }),
      typed: extractEnqueueDirective(docOf(paragraph(text("/enqueue fix it"))), { typed: false }),
    }).toEqual({
      picked: { kind: "enqueue-message", content: docOf(paragraph(text("fix /enqueue it"))) },
      typed: null,
    })
  })

  it("should leave paths, URLs, longer names, glued tokens, and code alone", () => {
    const mention: JSONContent = { type: "mention", attrs: { id: "usr_1", slug: "bob" } }
    const doc = docOf(
      paragraph(text("https://example.com/enqueue /enqueue-more foo/enqueue Yes./enqueue (/enqueue) /enqueue.")),
      paragraph(mention, text("/enqueue")),
      paragraph(text("/enq", [{ type: "bold" }]), text("ueue later")),
      paragraph(text("type "), text("/enqueue", [{ type: "code" }]), text(" to wait")),
      { type: "codeBlock", content: [text("/enqueue")] }
    )
    expect(extractEnqueueDirective(doc, typed)).toBeNull()
  })
})

describe("withEnqueueDirective", () => {
  it.each([
    { name: "a paragraph", input: docOf(paragraph(text("fix it")), paragraph(text("then this"))) },
    {
      name: "a list",
      input: docOf({ type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("a"))] }] }),
    },
  ])("should lead $name with a picked /enqueue that extraction takes back out", ({ input }) => {
    const seeded = withEnqueueDirective(input)
    expect({
      first: seeded.content?.[0]?.content?.[0],
      extracted: extractEnqueueDirective(seeded, { typed: false }),
    }).toEqual({
      first: { type: "slashCommand", attrs: { name: "enqueue" } },
      extracted: { kind: "enqueue-message", content: input },
    })
  })
})

describe("extractCommandFromRawText", () => {
  it("extracts a command with trailing whitespace", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "/model " }] }],
    }
    expect(extractCommandFromRawText(doc)).toEqual({ name: "model", args: "" })
  })

  it("extracts a command with arguments", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "  /thinking high  " }] }],
    }
    expect(extractCommandFromRawText(doc)).toEqual({ name: "thinking", args: "high" })
  })

  it("is case-insensitive", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "/MODEL" }] }],
    }
    expect(extractCommandFromRawText(doc)).toEqual({ name: "model", args: "" })
  })

  it("returns null for multi-paragraph messages", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "/model" }] },
        { type: "paragraph", content: [{ type: "text", text: "more" }] },
      ],
    }
    expect(extractCommandFromRawText(doc)).toBeNull()
  })

  it("returns null when other nodes are present", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "/model" },
            { type: "mention", attrs: { slug: "alice" } },
          ],
        },
      ],
    }
    expect(extractCommandFromRawText(doc)).toBeNull()
  })

  it("returns null for plain text that does not start with a slash", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "I tried /model" }] }],
    }
    expect(extractCommandFromRawText(doc)).toBeNull()
  })
})

describe("commandDoc", () => {
  it("should build a slash command node with its args when args are present", () => {
    expect(commandDoc("spawn", "claude fixer")).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "slashCommand", attrs: { name: "spawn" } },
            { type: "text", text: " claude fixer" },
          ],
        },
      ],
    })
  })

  it("should omit the text node when there are no args", () => {
    expect(commandDoc("done", "  ")).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "slashCommand", attrs: { name: "done" } }] }],
    })
  })

  it("should round-trip through extractCommandNode", () => {
    expect(extractCommandNode(commandDoc("spawn", "x"))).toEqual({ name: "spawn", clientActionId: null })
  })
})
