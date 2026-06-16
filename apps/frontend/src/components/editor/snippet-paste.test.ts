import { describe, expect, it } from "vitest"
import {
  shouldConvertPasteToSnippet,
  defaultSnippetFilename,
  SNIPPET_PASTE_CHAR_THRESHOLD,
  SNIPPET_PASTE_LINE_THRESHOLD,
} from "./snippet-paste"

describe("shouldConvertPasteToSnippet", () => {
  it("leaves ordinary short pastes inline", () => {
    expect(shouldConvertPasteToSnippet("just a normal sentence")).toBe(false)
    expect(shouldConvertPasteToSnippet("")).toBe(false)
    expect(shouldConvertPasteToSnippet("line one\nline two\nline three")).toBe(false)
  })

  it("converts a long single-blob paste on character count", () => {
    const blob = "x".repeat(SNIPPET_PASTE_CHAR_THRESHOLD)
    expect(shouldConvertPasteToSnippet(blob)).toBe(true)
    expect(shouldConvertPasteToSnippet("x".repeat(SNIPPET_PASTE_CHAR_THRESHOLD - 1))).toBe(false)
  })

  it("converts a tall paste on line count even when short", () => {
    const tall = Array.from({ length: SNIPPET_PASTE_LINE_THRESHOLD }, (_, i) => `l${i}`).join("\n")
    expect(shouldConvertPasteToSnippet(tall)).toBe(true)
    const justUnder = Array.from({ length: SNIPPET_PASTE_LINE_THRESHOLD - 1 }, (_, i) => `l${i}`).join("\n")
    expect(shouldConvertPasteToSnippet(justUnder)).toBe(false)
  })

  it("counts CRLF newlines the same as LF", () => {
    const tall = Array.from({ length: SNIPPET_PASTE_LINE_THRESHOLD }, (_, i) => `l${i}`).join("\r\n")
    expect(shouldConvertPasteToSnippet(tall)).toBe(true)
  })
})

describe("defaultSnippetFilename", () => {
  it("numbers snippets per session", () => {
    expect(defaultSnippetFilename(1)).toBe("snippet-1.txt")
    expect(defaultSnippetFilename(3)).toBe("snippet-3.txt")
  })
})
