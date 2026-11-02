import { describe, it, expect } from "vitest"
import { stripMarkdown, stripMarkdownToInline } from "./strip"

describe("stripMarkdown", () => {
  it("removes bold and italic markers", () => {
    expect(stripMarkdown("**Deploy succeeded** on _main_")).toBe("Deploy succeeded on main")
  })

  it("strips combined bold-italic underscore runs", () => {
    expect(stripMarkdown("___bold and italic___")).toBe("bold and italic")
  })

  it("preserves underscores that are part of identifiers", () => {
    expect(stripMarkdown(":white_check_mark: Deploy Cloudflare succeeded")).toBe(
      ":white_check_mark: Deploy Cloudflare succeeded"
    )
  })

  it("preserves intra-word underscores even when surrounded by text", () => {
    expect(stripMarkdown("see foo_bar_baz for details")).toBe("see foo_bar_baz for details")
  })

  it("strips link syntax but keeps the link text", () => {
    expect(stripMarkdown("Staging deployed — [feat(messaging): metadata](https://example.com/pr/367)")).toBe(
      "Staging deployed — feat(messaging): metadata"
    )
  })

  it("strips inline code fences but keeps the content", () => {
    expect(stripMarkdown("run `bun test`")).toBe("run bun test")
  })

  it("strips fenced code blocks but keeps inner content", () => {
    expect(stripMarkdown("```ts\nconst x = 1\n```")).toBe("const x = 1")
  })

  it("strips headers", () => {
    expect(stripMarkdown("# Heading\nbody")).toBe("Heading\nbody")
  })

  it("strips blockquote markers", () => {
    expect(stripMarkdown("> quoted line")).toBe("quoted line")
  })
})

describe("stripMarkdownToInline", () => {
  it("should drop the backslash of a hard break", () => {
    expect(stripMarkdownToInline("line one\\\nline two")).toBe("line one line two")
  })

  it("collapses newlines so the result is a single line", () => {
    expect(stripMarkdownToInline("line one\n\nline two\nline three")).toBe("line one line two line three")
  })

  it("strips markdown and collapses in one pass", () => {
    expect(stripMarkdownToInline("**hi**\n_world_")).toBe("hi world")
  })

  it("resolves emoji shortcodes when a resolver is provided", () => {
    const toEmoji = (shortcode: string) => (shortcode === "white_check_mark" ? "✅" : null)
    expect(stripMarkdownToInline(":white_check_mark: **Deploy succeeded**", toEmoji)).toBe("✅ Deploy succeeded")
  })

  it("leaves unresolved shortcodes untouched", () => {
    const toEmoji = (shortcode: string) => (shortcode === "rocket" ? "🚀" : null)
    expect(stripMarkdownToInline(":rocket: launching :unknown_thing:", toEmoji)).toBe("🚀 launching :unknown_thing:")
  })

  it("does not touch shortcodes when no resolver is provided", () => {
    expect(stripMarkdownToInline(":wave: hello")).toBe(":wave: hello")
  })
})
