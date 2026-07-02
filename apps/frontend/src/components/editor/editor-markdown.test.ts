import { describe, it, expect } from "vitest"
import type { JSONContent } from "@tiptap/react"
import { serializeToMarkdown, parseMarkdown } from "./editor-markdown"

describe("editor-markdown", () => {
  describe("serializeToMarkdown", () => {
    describe("block elements", () => {
      it("should serialize paragraph", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] }],
        }

        expect(serializeToMarkdown(doc)).toBe("Hello world")
      })

      it("should serialize multiple paragraphs with blank line between", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "First" }] },
            { type: "paragraph", content: [{ type: "text", text: "Second" }] },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("First\n\nSecond")
      })

      it("should serialize headings with correct level", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Title" }] },
            { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Subtitle" }] },
            { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Section" }] },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("# Title\n\n## Subtitle\n\n### Section")
      })

      it("should serialize code block with language", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "codeBlock",
              attrs: { language: "typescript" },
              content: [{ type: "text", text: "const x = 1" }],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("```typescript\nconst x = 1\n```")
      })

      it("should serialize code block without language", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "codeBlock",
              content: [{ type: "text", text: "plain code" }],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("```\nplain code\n```")
      })

      it("should serialize empty code block", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [{ type: "codeBlock", attrs: { language: "js" } }],
        }

        expect(serializeToMarkdown(doc)).toBe("```js\n\n```")
      })

      it("should serialize blockquote", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "blockquote",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Quoted text" }] }],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("> Quoted text")
      })

      it("should serialize multi-line blockquote", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "blockquote",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Line one" }] },
                { type: "paragraph", content: [{ type: "text", text: "Line two" }] },
              ],
            },
          ],
        }

        // Each paragraph in blockquote gets "> " prefix, joined by newlines
        expect(serializeToMarkdown(doc)).toBe("> Line one\n> Line two")
      })

      it("should serialize bullet list", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "bulletList",
              content: [
                { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Item one" }] }] },
                { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Item two" }] }] },
              ],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("- Item one\n- Item two")
      })

      it("should serialize ordered list", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "orderedList",
              content: [
                { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "First" }] }] },
                { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Second" }] }] },
              ],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("1. First\n2. Second")
      })

      it("should serialize horizontal rule", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Above" }] },
            { type: "horizontalRule" },
            { type: "paragraph", content: [{ type: "text", text: "Below" }] },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("Above\n\n---\n\nBelow")
      })

      it("should serialize hard break as newline", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Line one" }, { type: "hardBreak" }, { type: "text", text: "Line two" }],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("Line one\nLine two")
      })
    })

    describe("inline formatting", () => {
      it("should serialize bold text", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "bold", marks: [{ type: "bold" }] }],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("**bold**")
      })

      it("should serialize italic text", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "italic", marks: [{ type: "italic" }] }],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("*italic*")
      })

      it("should serialize strikethrough text", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "deleted", marks: [{ type: "strike" }] }],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("~~deleted~~")
      })

      it("should serialize inline code", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "code", marks: [{ type: "code" }] }],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("`code`")
      })

      it("should serialize link", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "click here", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
              ],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("[click here](https://example.com)")
      })

      it("should preserve URL fragments when autolink text contains the full URL", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "https://github.com/threahq/priv-test/blob/main/README.md?plain=1#L4",
                  marks: [
                    {
                      type: "link",
                      attrs: { href: "https://github.com/threahq/priv-test/blob/main/README.md?plain=1" },
                    },
                  ],
                },
              ],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe(
          "[https://github.com/threahq/priv-test/blob/main/README.md?plain=1#L4](https://github.com/threahq/priv-test/blob/main/README.md?plain=1#L4)"
        )
      })

      it("should serialize mixed inline content", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Normal " },
                { type: "text", text: "bold", marks: [{ type: "bold" }] },
                { type: "text", text: " and " },
                { type: "text", text: "italic", marks: [{ type: "italic" }] },
              ],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("Normal **bold** and *italic*")
      })

      it("should serialize nested marks (bold + italic)", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "emphasis", marks: [{ type: "bold" }, { type: "italic" }] }],
            },
          ],
        }

        // Marks applied in order: bold then italic wraps it
        expect(serializeToMarkdown(doc)).toBe("***emphasis***")
      })
    })

    describe("empty content", () => {
      it("should return empty string for doc without content", () => {
        const doc: JSONContent = { type: "doc" }
        expect(serializeToMarkdown(doc)).toBe("")
      })

      it("should return empty string for doc with empty content array", () => {
        const doc: JSONContent = { type: "doc", content: [] }
        expect(serializeToMarkdown(doc)).toBe("")
      })

      it("should serialize empty paragraph", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [{ type: "paragraph" }],
        }

        expect(serializeToMarkdown(doc)).toBe("")
      })
    })
  })

  describe("parseMarkdown", () => {
    describe("block elements", () => {
      it("should parse paragraph", () => {
        const result = parseMarkdown("Hello world")

        expect(result).toEqual({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Hello world" }],
            },
          ],
        })
      })

      it("should parse heading levels", () => {
        const result = parseMarkdown("# H1\n\n## H2\n\n### H3")

        expect(result.content).toHaveLength(3)
        expect(result.content?.[0]).toMatchObject({ type: "heading", attrs: { level: 1 } })
        expect(result.content?.[1]).toMatchObject({ type: "heading", attrs: { level: 2 } })
        expect(result.content?.[2]).toMatchObject({ type: "heading", attrs: { level: 3 } })
      })

      it("should parse code block with language", () => {
        const result = parseMarkdown("```typescript\nconst x = 1\n```")

        expect(result.content?.[0]).toEqual({
          type: "codeBlock",
          attrs: { language: "typescript" },
          content: [{ type: "text", text: "const x = 1" }],
        })
      })

      it("should parse code block without language", () => {
        const result = parseMarkdown("```\nplain code\n```")

        expect(result.content?.[0]).toMatchObject({
          type: "codeBlock",
          attrs: { language: null },
        })
      })

      it("should parse multi-line code block", () => {
        const result = parseMarkdown("```js\nline1\nline2\nline3\n```")

        expect(result.content?.[0]).toEqual({
          type: "codeBlock",
          attrs: { language: "js" },
          content: [{ type: "text", text: "line1\nline2\nline3" }],
        })
      })

      it("should parse blockquote", () => {
        const result = parseMarkdown("> Quoted text")

        expect(result.content?.[0]).toMatchObject({
          type: "blockquote",
          content: [{ type: "paragraph" }],
        })
      })

      it("should parse bullet list with dash", () => {
        const result = parseMarkdown("- Item one\n- Item two")

        expect(result.content?.[0]).toMatchObject({
          type: "bulletList",
          content: [{ type: "listItem" }, { type: "listItem" }],
        })
      })

      it("should parse bullet list with asterisk", () => {
        const result = parseMarkdown("* Item one\n* Item two")

        expect(result.content?.[0]).toMatchObject({
          type: "bulletList",
          content: [{ type: "listItem" }, { type: "listItem" }],
        })
      })

      it("should parse ordered list", () => {
        const result = parseMarkdown("1. First\n2. Second")

        expect(result.content?.[0]).toMatchObject({
          type: "orderedList",
          content: [{ type: "listItem" }, { type: "listItem" }],
        })
      })

      it("should parse horizontal rule with dashes", () => {
        const result = parseMarkdown("---")
        expect(result.content?.[0]).toEqual({ type: "horizontalRule" })
      })

      it("should parse horizontal rule with asterisks", () => {
        const result = parseMarkdown("***")
        expect(result.content?.[0]).toEqual({ type: "horizontalRule" })
      })
    })

    describe("inline formatting", () => {
      it("should parse bold text", () => {
        const result = parseMarkdown("**bold**")

        expect(result.content?.[0]?.content?.[0]).toEqual({
          type: "text",
          text: "bold",
          marks: [{ type: "bold" }],
        })
      })

      it("should parse italic text", () => {
        const result = parseMarkdown("*italic*")

        expect(result.content?.[0]?.content?.[0]).toEqual({
          type: "text",
          text: "italic",
          marks: [{ type: "italic" }],
        })
      })

      it("should parse strikethrough", () => {
        const result = parseMarkdown("~~deleted~~")

        expect(result.content?.[0]?.content?.[0]).toEqual({
          type: "text",
          text: "deleted",
          marks: [{ type: "strike" }],
        })
      })

      it("should parse inline code", () => {
        const result = parseMarkdown("`code`")

        expect(result.content?.[0]?.content?.[0]).toEqual({
          type: "text",
          text: "code",
          marks: [{ type: "code" }],
        })
      })

      it("should parse link", () => {
        const result = parseMarkdown("[click](https://example.com)")

        expect(result.content?.[0]?.content?.[0]).toEqual({
          type: "text",
          text: "click",
          marks: [{ type: "link", attrs: { href: "https://example.com" } }],
        })
      })

      it("should parse mixed inline content", () => {
        const result = parseMarkdown("Normal **bold** text")
        const content = result.content?.[0]?.content

        expect(content).toHaveLength(3)
        expect(content?.[0]).toEqual({ type: "text", text: "Normal " })
        expect(content?.[1]).toEqual({ type: "text", text: "bold", marks: [{ type: "bold" }] })
        expect(content?.[2]).toEqual({ type: "text", text: " text" })
      })

      it("should distinguish between bold and italic asterisks", () => {
        const boldResult = parseMarkdown("**bold**")
        const italicResult = parseMarkdown("*italic*")

        expect(boldResult.content?.[0]?.content?.[0]?.marks?.[0]?.type).toBe("bold")
        expect(italicResult.content?.[0]?.content?.[0]?.marks?.[0]?.type).toBe("italic")
      })
    })

    describe("empty and edge cases", () => {
      it("should return empty doc for empty string", () => {
        const result = parseMarkdown("")
        expect(result).toEqual({ type: "doc", content: [{ type: "paragraph" }] })
      })

      it("should return empty doc for whitespace-only string", () => {
        const result = parseMarkdown("   \n\n   ")
        expect(result).toEqual({ type: "doc", content: [{ type: "paragraph" }] })
      })

      it("should skip empty lines between blocks", () => {
        const result = parseMarkdown("First\n\n\n\nSecond")
        expect(result.content).toHaveLength(2)
      })
    })
  })

  describe("round-trip integrity", () => {
    const roundTrip = (markdown: string): string => {
      const parsed = parseMarkdown(markdown)
      return serializeToMarkdown(parsed)
    }

    it("should preserve simple paragraph", () => {
      expect(roundTrip("Hello world")).toBe("Hello world")
    })

    it("should preserve heading", () => {
      expect(roundTrip("# Title")).toBe("# Title")
      expect(roundTrip("## Subtitle")).toBe("## Subtitle")
    })

    it("should preserve code block with language", () => {
      const md = "```typescript\nconst x = 1\n```"
      expect(roundTrip(md)).toBe(md)
    })

    it("should preserve bullet list", () => {
      expect(roundTrip("- Item one\n- Item two")).toBe("- Item one\n- Item two")
    })

    it("should preserve ordered list", () => {
      expect(roundTrip("1. First\n2. Second")).toBe("1. First\n2. Second")
    })

    it("should preserve bold text", () => {
      expect(roundTrip("**bold**")).toBe("**bold**")
    })

    it("should preserve italic text", () => {
      expect(roundTrip("*italic*")).toBe("*italic*")
    })

    it("should preserve inline code", () => {
      expect(roundTrip("`code`")).toBe("`code`")
    })

    it("should preserve link", () => {
      expect(roundTrip("[text](https://example.com)")).toBe("[text](https://example.com)")
    })

    it("should preserve horizontal rule", () => {
      expect(roundTrip("---")).toBe("---")
    })

    it("should round-trip a sharedMessage node losslessly", () => {
      const doc: JSONContent = {
        type: "doc",
        content: [
          {
            type: "sharedMessage",
            attrs: {
              messageId: "msg_01ABC",
              streamId: "stream_01XYZ",
              authorName: "Ariadne",
              authorId: "",
              actorType: "user",
            },
          },
        ],
      }

      const md = serializeToMarkdown(doc)
      expect(md).toBe("Shared a message from [Ariadne](shared-message:stream_01XYZ/msg_01ABC)")

      const parsed = parseMarkdown(md)
      expect(parsed.content?.[0]).toEqual({
        type: "sharedMessage",
        attrs: {
          messageId: "msg_01ABC",
          streamId: "stream_01XYZ",
          authorName: "Ariadne",
          authorId: "",
          actorType: "user",
        },
      })
    })

    it("should preserve mixed document", () => {
      const md = `# Heading

This is a paragraph with **bold** and *italic* text.

\`\`\`js
const x = 1
\`\`\`

- List item one
- List item two`

      const result = roundTrip(md)
      expect(result).toContain("# Heading")
      expect(result).toContain("**bold**")
      expect(result).toContain("*italic*")
      expect(result).toContain("```js")
      expect(result).toContain("- List item")
    })
  })

  describe("mentions and channels", () => {
    describe("serialization", () => {
      it("should serialize mention node to @slug format", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Hey " },
                {
                  type: "mention",
                  attrs: { id: "usr_123", slug: "kristoffer", name: "Kristoffer", mentionType: "user" },
                },
                { type: "text", text: " check this out" },
              ],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("Hey [@kristoffer](user:usr_123) check this out")
      })

      it("should serialize channel link node to #slug format", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "See " },
                { type: "channelLink", attrs: { id: "stream_456", slug: "general", name: "General" } },
                { type: "text", text: " for details" },
              ],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("See [#general](channel:stream_456) for details")
      })

      it("should serialize multiple mentions in same paragraph", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "mention", attrs: { id: "usr_1", slug: "alice", name: "Alice", mentionType: "user" } },
                { type: "text", text: " and " },
                { type: "mention", attrs: { id: "usr_2", slug: "bob", name: "Bob", mentionType: "user" } },
              ],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("[@alice](user:usr_1) and [@bob](user:usr_2)")
      })

      it("should serialize broadcast mentions", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "mention",
                  attrs: { id: "broadcast_channel", slug: "channel", name: "channel", mentionType: "broadcast" },
                },
                { type: "text", text: " please review" },
              ],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("@channel please review")
      })

      it("should serialize mixed mentions and channels", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "mention",
                  attrs: { id: "usr_1", slug: "kristoffer", name: "Kristoffer", mentionType: "user" },
                },
                { type: "text", text: " posted in " },
                { type: "channelLink", attrs: { id: "stream_1", slug: "engineering", name: "Engineering" } },
              ],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("[@kristoffer](user:usr_1) posted in [#engineering](channel:stream_1)")
      })

      it("should handle mention node without slug gracefully", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Hello " },
                { type: "mention", attrs: { id: "usr_123" } },
                { type: "text", text: " there" },
              ],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("Hello  there")
      })

      it("should wrap mention with bold when adjacent text is bold", () => {
        // When user selects "@here hello" and applies bold, ProseMirror produces:
        // [mention @here] [text " hello" with bold mark]
        // This should serialize as **@here hello** (not @here ** hello**)
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "mention",
                  attrs: { id: "broadcast:here", slug: "here", name: "Here", mentionType: "broadcast" },
                },
                { type: "text", text: " hello", marks: [{ type: "bold" }] },
              ],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("**[@here](broadcast:here) hello**")
      })

      it("should wrap mention with italic when adjacent text is italic", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "mention",
                  attrs: { id: "usr_1", slug: "kristoffer", name: "Kristoffer", mentionType: "user" },
                },
                { type: "text", text: " check this", marks: [{ type: "italic" }] },
              ],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("*[@kristoffer](user:usr_1) check this*")
      })

      it("should wrap channel with code when adjacent text has code mark", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "see ", marks: [{ type: "code" }] },
                { type: "channelLink", attrs: { id: "stream_1", slug: "general", name: "General" } },
              ],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("`see [#general](channel:stream_1)`")
      })

      it("should preserve trailing whitespace outside bold marks", () => {
        // "Hello @ariadne " with bold should become "**Hello @ariadne** " not "**Hello @ariadne **"
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Hello ", marks: [{ type: "bold" }] },
                {
                  type: "mention",
                  attrs: { id: "persona_1", slug: "ariadne", name: "Ariadne", mentionType: "persona" },
                },
                { type: "text", text: " ", marks: [{ type: "bold" }] },
              ],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("**Hello [@ariadne](persona:persona_1)** ")
      })

      it("should preserve leading whitespace outside marks", () => {
        // " Hello" with italic should become " *Hello*" not "* Hello*"
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: " Hello world", marks: [{ type: "italic" }] }],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe(" *Hello world*")
      })

      it("should preserve both leading and trailing whitespace outside marks", () => {
        // "  content  " with strike should become "  ~~content~~  "
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "  hello world  ", marks: [{ type: "strike" }] }],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("  ~~hello world~~  ")
      })

      it("should not wrap pure whitespace with marks", () => {
        // Adjacent groups: "Hello" (bold) + "   " (bold) + "world" (no mark)
        // Should become "**Hello**   world" not "**Hello****   **world"
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Hello", marks: [{ type: "bold" }] },
                { type: "text", text: "   " }, // pure whitespace, no marks
                { type: "text", text: "world" },
              ],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("**Hello**   world")
      })

      it("should wrap mention with code when followed by text with code mark", () => {
        // When user selects "@ariadne hello" and applies code via toolbar:
        // The mention can't have marks (it's an atom), but the following text does
        // The mention should inherit the code mark from adjacent text
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "mention",
                  attrs: { id: "persona_1", slug: "ariadne", name: "Ariadne", mentionType: "persona" },
                },
                { type: "text", text: " hello", marks: [{ type: "code" }] },
              ],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("`[@ariadne](persona:persona_1) hello`")
      })

      it("should wrap mention with strikethrough when surrounded by strikethrough text", () => {
        // When user types "~~Hello @ariadne world~~" or applies via toolbar
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Hello ", marks: [{ type: "strike" }] },
                {
                  type: "mention",
                  attrs: { id: "user_1", slug: "ariadne", name: "Ariadne", mentionType: "user" },
                },
                { type: "text", text: " world", marks: [{ type: "strike" }] },
              ],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("~~Hello @ariadne world~~")
      })
    })

    describe("parsing", () => {
      it("should parse @mention into mention node", () => {
        const result = parseMarkdown("Hey @kristoffer check this out")
        const content = result.content?.[0]?.content

        expect(content).toHaveLength(3)
        expect(content?.[0]).toEqual({ type: "text", text: "Hey " })
        expect(content?.[1]).toEqual({
          type: "mention",
          attrs: { id: "kristoffer", slug: "kristoffer", mentionType: "user" },
        })
        expect(content?.[2]).toEqual({ type: "text", text: " check this out" })
      })

      it("should parse #channel into channelLink node", () => {
        const result = parseMarkdown("See #general for details")
        const content = result.content?.[0]?.content

        expect(content).toHaveLength(3)
        expect(content?.[0]).toEqual({ type: "text", text: "See " })
        expect(content?.[1]).toEqual({
          type: "channelLink",
          attrs: { id: "general", slug: "general" },
        })
        expect(content?.[2]).toEqual({ type: "text", text: " for details" })
      })

      it("keeps mentions, channels, slash commands, and emoji as plain text when token parsing is disabled", () => {
        const source = "See #general and @alice\n\n/todo\n\n:wave:"
        const result = parseMarkdown(source, undefined, undefined, {
          enableMentions: false,
          enableChannels: false,
          enableSlashCommands: false,
          enableEmoji: false,
        })

        expect(serializeToMarkdown(result)).toBe(source)
        expect(result.content?.flatMap((block) => block.content ?? []).every((node) => node.type === "text")).toBe(true)
      })

      it("should parse multiple mentions", () => {
        const result = parseMarkdown("@alice and @bob")
        const content = result.content?.[0]?.content

        expect(content).toHaveLength(3)
        expect(content?.[0]?.type).toBe("mention")
        expect(content?.[0]?.attrs?.slug).toBe("alice")
        expect(content?.[1]).toEqual({ type: "text", text: " and " })
        expect(content?.[2]?.type).toBe("mention")
        expect(content?.[2]?.attrs?.slug).toBe("bob")
      })

      it("should parse mentions with hyphens in slug", () => {
        const result = parseMarkdown("Hey @kristoffer-remback")
        const content = result.content?.[0]?.content

        expect(content?.[1]?.type).toBe("mention")
        expect(content?.[1]?.attrs?.slug).toBe("kristoffer-remback")
      })

      it("should parse channels with hyphens in slug", () => {
        const result = parseMarkdown("Check #dev-team")
        const content = result.content?.[0]?.content

        expect(content?.[1]?.type).toBe("channelLink")
        expect(content?.[1]?.attrs?.slug).toBe("dev-team")
      })

      it("should parse mixed mentions and channels", () => {
        const result = parseMarkdown("@alice posted in #general")
        const content = result.content?.[0]?.content

        expect(content).toHaveLength(3)
        expect(content?.[0]?.type).toBe("mention")
        expect(content?.[1]).toEqual({ type: "text", text: " posted in " })
        expect(content?.[2]?.type).toBe("channelLink")
      })

      it("should parse mention at start of text", () => {
        const result = parseMarkdown("@kristoffer")
        const content = result.content?.[0]?.content

        expect(content).toHaveLength(1)
        expect(content?.[0]?.type).toBe("mention")
        expect(content?.[0]?.attrs?.slug).toBe("kristoffer")
      })

      it("should parse channel at end of text", () => {
        const result = parseMarkdown("Check out #general")
        const content = result.content?.[0]?.content

        expect(content).toHaveLength(2)
        expect(content?.[0]).toEqual({ type: "text", text: "Check out " })
        expect(content?.[1]?.type).toBe("channelLink")
      })
      it("should not parse @ as mention when not preceded by whitespace (email address)", () => {
        const result = parseMarkdown("test@gmail.com")
        const content = result.content?.[0]?.content

        expect(content).toHaveLength(1)
        expect(content?.[0]).toEqual({ type: "text", text: "test@gmail.com" })
      })

      it("should not parse # as channel when not preceded by whitespace", () => {
        const result = parseMarkdown("issue#123")
        const content = result.content?.[0]?.content

        expect(content).toHaveLength(1)
        expect(content?.[0]).toEqual({ type: "text", text: "issue#123" })
      })

      it("should not parse @ in parentheses without preceding whitespace", () => {
        const result = parseMarkdown("email(user@example.com)")
        const content = result.content?.[0]?.content

        expect(content).toHaveLength(1)
        expect(content?.[0]).toEqual({ type: "text", text: "email(user@example.com)" })
      })
    })

    describe("round-trip", () => {
      it("should preserve mention through round-trip", () => {
        const md = "Hey @kristoffer check this"
        const parsed = parseMarkdown(md)
        const serialized = serializeToMarkdown(parsed)
        expect(serialized).toBe(md)
      })

      it("should preserve channel through round-trip", () => {
        const md = "See #general for info"
        const parsed = parseMarkdown(md)
        const serialized = serializeToMarkdown(parsed)
        expect(serialized).toBe(md)
      })

      it("should preserve mixed mentions and channels through round-trip", () => {
        const md = "@alice and @bob check #engineering"
        const parsed = parseMarkdown(md)
        const serialized = serializeToMarkdown(parsed)
        expect(serialized).toBe(md)
      })

      it("should preserve mention with surrounding formatting", () => {
        const md = "**Important:** @kristoffer please review"
        const parsed = parseMarkdown(md)
        const serialized = serializeToMarkdown(parsed)
        expect(serialized).toBe(md)
      })
    })
  })

  describe("edge cases", () => {
    it("should handle asterisk in middle of word (not italic)", () => {
      const result = parseMarkdown("file*name")
      // Should remain as plain text, not parsed as italic
      const content = result.content?.[0]?.content
      expect(content?.some((n) => n.marks?.some((m) => m.type === "italic"))).toBeFalsy()
    })

    it("should handle code block with backticks inside", () => {
      const md = "```\nconst s = `template`\n```"
      const result = parseMarkdown(md)
      expect(result.content?.[0]?.type).toBe("codeBlock")
      expect(result.content?.[0]?.content?.[0]?.text).toContain("`template`")
    })

    it("should handle consecutive formatting", () => {
      const result = parseMarkdown("**bold****more bold**")
      const content = result.content?.[0]?.content
      // Both segments should have bold marks
      expect(content?.every((n) => n.marks?.some((m) => m.type === "bold"))).toBe(true)
    })

    it("should handle link with special characters in URL", () => {
      const md = "[search](https://example.com/search?q=test&page=1)"
      const result = parseMarkdown(md)
      expect(result.content?.[0]?.content?.[0]?.marks?.[0]?.attrs?.href).toBe(
        "https://example.com/search?q=test&page=1"
      )
    })

    it("should handle heading with inline formatting", () => {
      const result = parseMarkdown("# Title with **bold**")
      const heading = result.content?.[0]
      expect(heading?.type).toBe("heading")
      expect(heading?.content?.some((n) => n.marks?.some((m) => m.type === "bold"))).toBe(true)
    })
  })

  describe("attachment references", () => {
    describe("serialization", () => {
      it("should serialize image attachment reference", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Check this " },
                {
                  type: "attachmentReference",
                  attrs: {
                    id: "attach_123",
                    filename: "screenshot.png",
                    mimeType: "image/png",
                    sizeBytes: 1024,
                    status: "uploaded",
                    imageIndex: 1,
                    error: null,
                  },
                },
              ],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe(
          'Check this [Image #1](attachment:attach_123 "threa-attachment:filename=screenshot.png&mimeType=image%2Fpng&sizeBytes=1024")'
        )
      })

      it("should serialize file attachment reference", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "attachmentReference",
                  attrs: {
                    id: "attach_456",
                    filename: "report.pdf",
                    mimeType: "application/pdf",
                    sizeBytes: 2048,
                    status: "uploaded",
                    imageIndex: null,
                    error: null,
                  },
                },
              ],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe(
          '[report.pdf](attachment:attach_456 "threa-attachment:filename=report.pdf&mimeType=application%2Fpdf&sizeBytes=2048")'
        )
      })

      it("should skip uploading attachments in serialization", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Text with " },
                {
                  type: "attachmentReference",
                  attrs: {
                    id: "temp_123",
                    filename: "uploading.png",
                    mimeType: "image/png",
                    sizeBytes: 1024,
                    status: "uploading",
                    imageIndex: 1,
                    error: null,
                  },
                },
                { type: "text", text: " in progress" },
              ],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("Text with  in progress")
      })

      it("should skip error attachments in serialization", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "attachmentReference",
                  attrs: {
                    id: "temp_456",
                    filename: "failed.png",
                    mimeType: "image/png",
                    sizeBytes: 1024,
                    status: "error",
                    imageIndex: 1,
                    error: "Upload failed",
                  },
                },
              ],
            },
          ],
        }

        expect(serializeToMarkdown(doc)).toBe("")
      })
    })

    describe("parsing", () => {
      it("should parse image attachment reference", () => {
        const result = parseMarkdown(
          'See [Image #1](attachment:attach_123 "threa-attachment:filename=screenshot.png&mimeType=image%2Fpng&sizeBytes=1024")'
        )
        const content = result.content?.[0]?.content

        expect(content).toHaveLength(2)
        expect(content?.[0]).toEqual({ type: "text", text: "See " })
        expect(content?.[1]?.type).toBe("attachmentReference")
        expect(content?.[1]?.attrs).toMatchObject({
          id: "attach_123",
          filename: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 1024,
          imageIndex: 1,
          status: "uploaded",
        })
      })

      it("should parse file attachment reference", () => {
        const result = parseMarkdown(
          '[report.pdf](attachment:attach_456 "threa-attachment:filename=report.pdf&mimeType=application%2Fpdf&sizeBytes=2048")'
        )
        const content = result.content?.[0]?.content

        expect(content).toHaveLength(1)
        expect(content?.[0]?.type).toBe("attachmentReference")
        expect(content?.[0]?.attrs).toMatchObject({
          id: "attach_456",
          filename: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2048,
          imageIndex: null,
          status: "uploaded",
        })
      })

      it("should parse legacy attachment reference without metadata as unknown size", () => {
        const result = parseMarkdown("[report.pdf](attachment:attach_456)")
        const content = result.content?.[0]?.content

        expect(content?.[0]?.type).toBe("attachmentReference")
        expect(content?.[0]?.attrs).toMatchObject({
          id: "attach_456",
          filename: "report.pdf",
          mimeType: "application/octet-stream",
          sizeBytes: null,
          status: "uploaded",
        })
      })

      it("should parse legacy escaped attachment labels without metadata", () => {
        const result = parseMarkdown("[report\\[final\\]\\\\v2\\].pdf](attachment:attach_456)")
        const content = result.content?.[0]?.content

        expect(content?.[0]?.type).toBe("attachmentReference")
        expect(content?.[0]?.attrs).toMatchObject({
          id: "attach_456",
          filename: "report[final]\\v2].pdf",
          mimeType: "application/octet-stream",
          sizeBytes: null,
          status: "uploaded",
        })
      })

      it("should not confuse regular links with attachment references", () => {
        const result = parseMarkdown("[link](https://example.com)")
        const content = result.content?.[0]?.content

        expect(content?.[0]?.type).toBe("text")
        expect(content?.[0]?.marks?.[0]?.type).toBe("link")
        expect(content?.[0]?.marks?.[0]?.attrs?.href).toBe("https://example.com")
      })
    })

    describe("round-trip", () => {
      it("should preserve image attachment through round-trip", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "attachmentReference",
                  attrs: {
                    id: "attach_789",
                    filename: "photo.png",
                    mimeType: "image/png",
                    sizeBytes: 4096,
                    status: "uploaded",
                    imageIndex: 2,
                    error: null,
                  },
                },
              ],
            },
          ],
        }

        const md = serializeToMarkdown(doc)
        expect(md).toBe(
          '[Image #2](attachment:attach_789 "threa-attachment:filename=photo.png&mimeType=image%2Fpng&sizeBytes=4096")'
        )

        const parsed = parseMarkdown(md)
        expect(parsed.content?.[0]?.content?.[0]?.type).toBe("attachmentReference")
        expect(parsed.content?.[0]?.content?.[0]?.attrs).toMatchObject({
          filename: "photo.png",
          mimeType: "image/png",
          sizeBytes: 4096,
          imageIndex: 2,
        })
      })

      it("should preserve file attachment through round-trip", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "attachmentReference",
                  attrs: {
                    id: "attach_abc",
                    filename: "document.docx",
                    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    sizeBytes: 8192,
                    status: "uploaded",
                    imageIndex: null,
                    error: null,
                  },
                },
              ],
            },
          ],
        }

        const md = serializeToMarkdown(doc)
        expect(md).toBe(
          '[document.docx](attachment:attach_abc "threa-attachment:filename=document.docx&mimeType=application%2Fvnd.openxmlformats-officedocument.wordprocessingml.document&sizeBytes=8192")'
        )

        const parsed = parseMarkdown(md)
        expect(parsed.content?.[0]?.content?.[0]?.type).toBe("attachmentReference")
        expect(parsed.content?.[0]?.content?.[0]?.attrs).toMatchObject({
          filename: "document.docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sizeBytes: 8192,
        })
      })

      it("should preserve attachment labels with brackets and backslashes through round-trip", () => {
        const doc: JSONContent = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "attachmentReference",
                  attrs: {
                    id: "attach_escaped",
                    filename: "report[final]\\v2].pdf",
                    mimeType: "application/pdf",
                    sizeBytes: 512,
                    status: "uploaded",
                    imageIndex: null,
                    error: null,
                  },
                },
              ],
            },
          ],
        }

        const md = serializeToMarkdown(doc)
        expect(md).toBe(
          '[report\\[final\\]\\\\v2\\].pdf](attachment:attach_escaped "threa-attachment:filename=report%5Bfinal%5D%5Cv2%5D.pdf&mimeType=application%2Fpdf&sizeBytes=512")'
        )

        const parsed = parseMarkdown(md)
        expect(parsed.content?.[0]?.content?.[0]?.type).toBe("attachmentReference")
        expect(parsed.content?.[0]?.content?.[0]?.attrs).toMatchObject({
          filename: "report[final]\\v2].pdf",
          mimeType: "application/pdf",
          sizeBytes: 512,
          imageIndex: null,
        })
      })
    })
  })
})
