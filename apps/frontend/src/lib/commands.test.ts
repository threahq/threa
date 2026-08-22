import { describe, it, expect } from "vitest"
import type { JSONContent } from "@threa/types"
import { extractCommandNode, extractCommandFromRawText, extractSteerDirective } from "./commands"

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

describe("extractSteerDirective", () => {
  it("detects a structural steer command at the start of a message without changing it", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "slashCommand", attrs: { name: "steer", clientActionId: null } },
            { type: "text", text: " I want option 2" },
          ],
        },
      ],
    }

    expect(extractSteerDirective(doc)).toEqual({ content: doc, hasMessageContent: true })
  })

  it("finds standalone raw steer tokens at the end, middle, and across paragraphs", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "I want option 2 /steer" }] },
        { type: "paragraph", content: [{ type: "text", text: "Yes./steer and also pizza" }] },
      ],
    }

    expect(extractSteerDirective(doc)).toEqual({ content: doc, hasMessageContent: true })
  })

  it("detects steer in later list items and nested block paragraphs", () => {
    const listDoc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "prep the release" }] }],
            },
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "/steer start with tests" }] }],
            },
          ],
        },
      ],
    }
    const quoteDoc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "context" }] },
            { type: "paragraph", content: [{ type: "text", text: "/steer use this" }] },
          ],
        },
      ],
    }

    expect(extractSteerDirective(listDoc)).toEqual({ content: listDoc, hasMessageContent: true })
    expect(extractSteerDirective(quoteDoc)).toEqual({ content: quoteDoc, hasMessageContent: true })
  })

  it("detects a structural steer node inside a list item", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "context" }] }],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "slashCommand", attrs: { name: "steer", clientActionId: null } }],
                },
              ],
            },
          ],
        },
      ],
    }

    expect(extractSteerDirective(doc)).toEqual({ content: doc, hasMessageContent: true })
  })

  it("detects a steer token split across formatting marks", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "/ste", marks: [{ type: "bold" }] },
            { type: "text", text: "er" },
            { type: "text", text: " keep the attachment" },
          ],
        },
      ],
    }

    expect(extractSteerDirective(doc)).toEqual({ content: doc, hasMessageContent: true })
  })

  it("treats a trailing-newline steer as a command with no message", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "/steer" }] }, { type: "paragraph" }],
    }

    expect(extractSteerDirective(doc)?.hasMessageContent).toBe(false)
  })

  it("keeps attachments as normal message content", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "attachmentReference", attrs: { id: "att_1", filename: "image.png" } },
            { type: "text", text: " /steer" },
          ],
        },
      ],
    }

    const extracted = extractSteerDirective(doc)
    expect(extracted?.hasMessageContent).toBe(true)
    expect(extracted?.content.content?.[0].content?.[0].type).toBe("attachmentReference")
  })

  it("does not match paths, URLs, or longer command names", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "https://example.com/steer /steer-more foo/steer" }],
        },
      ],
    }

    expect(extractSteerDirective(doc)).toBeNull()
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
