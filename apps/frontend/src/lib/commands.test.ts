import { describe, it, expect } from "vitest"
import type { JSONContent } from "@threa/types"
import { extractCommandNode, extractCommandFromRawText } from "./commands"

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
              attrs: { name: "discuss-with-ariadne", clientActionId: "discuss-with-ariadne" },
            },
          ],
        },
      ],
    }
    expect(extractCommandNode(doc)).toEqual({
      name: "discuss-with-ariadne",
      clientActionId: "discuss-with-ariadne",
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
