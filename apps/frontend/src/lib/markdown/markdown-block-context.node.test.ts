import { describe, it, expect } from "vitest"
import { composeBlockCollapseKey, hashMarkdownBlock } from "./markdown-block-context"

describe("hashMarkdownBlock", () => {
  it("returns a stable hash for identical content + namespace", () => {
    const a = hashMarkdownBlock("const x = 1", "typescript")
    const b = hashMarkdownBlock("const x = 1", "typescript")
    expect(a).toBe(b)
  })

  it("returns different hashes when content differs", () => {
    const a = hashMarkdownBlock("const x = 1", "typescript")
    const b = hashMarkdownBlock("const x = 2", "typescript")
    expect(a).not.toBe(b)
  })

  it("returns different hashes when namespace differs", () => {
    const a = hashMarkdownBlock("print('hi')", "python")
    const b = hashMarkdownBlock("print('hi')", "ruby")
    expect(a).not.toBe(b)
  })

  it("separates code and blockquote hash spaces via namespace", () => {
    const codeHash = hashMarkdownBlock("hello", "typescript")
    const quoteHash = hashMarkdownBlock("hello", "blockquote")
    expect(codeHash).not.toBe(quoteHash)
  })

  it("handles empty content", () => {
    const result = hashMarkdownBlock("", "text")
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })

  it("handles unicode content", () => {
    const a = hashMarkdownBlock("const greeting = '🚀'", "typescript")
    const b = hashMarkdownBlock("const greeting = '🎉'", "typescript")
    expect(a).not.toBe(b)
  })

  it("produces URL-safe base36 output", () => {
    const result = hashMarkdownBlock("some code", "js")
    expect(result).toMatch(/^[0-9a-z]+$/)
  })
})

describe("composeBlockCollapseKey", () => {
  it("encodes messageId, kind, and hash into a stable key", () => {
    const key = composeBlockCollapseKey("msg_1", "code", "abc")
    expect(key).toBe("msg_1:code:abc")
  })

  it("keeps code and blockquote keys separate for the same content hash", () => {
    const codeKey = composeBlockCollapseKey("msg_1", "code", "abc")
    const quoteKey = composeBlockCollapseKey("msg_1", "blockquote", "abc")
    expect(codeKey).not.toBe(quoteKey)
  })

  it("keeps quote-reply keys separate from plain blockquote keys", () => {
    const blockquote = composeBlockCollapseKey("msg_1", "blockquote", "abc")
    const quoteReply = composeBlockCollapseKey("msg_1", "quote-reply", "abc")
    expect(blockquote).not.toBe(quoteReply)
  })
})
