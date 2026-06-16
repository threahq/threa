import { describe, expect, it } from "vitest"
import { categoryFromMime } from "@threa/types"
import {
  shouldConvertPasteToSnippet,
  defaultSnippetFilename,
  detectSnippetFormat,
  snippetFormatForFilename,
  snippetMimeForFilename,
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
  it("defaults to a .txt extension", () => {
    expect(defaultSnippetFilename(1)).toBe("snippet-1.txt")
    expect(defaultSnippetFilename(3)).toBe("snippet-3.txt")
  })

  it("uses the detected extension when given one", () => {
    expect(defaultSnippetFilename(2, "json")).toBe("snippet-2.json")
    expect(defaultSnippetFilename(5, "md")).toBe("snippet-5.md")
  })
})

describe("detectSnippetFormat", () => {
  it("falls back to plain text for empty or prose input", () => {
    expect(detectSnippetFormat("").key).toBe("text")
    expect(detectSnippetFormat("   ").key).toBe("text")
    expect(detectSnippetFormat("Just an ordinary paragraph, with a comma or two.").key).toBe("text")
  })

  it("detects parse-verified JSON objects and arrays", () => {
    expect(detectSnippetFormat(`{ "a": 1, "b": [2, 3] }`).key).toBe("json")
    expect(detectSnippetFormat(`[\n  { "id": 1 },\n  { "id": 2 }\n]`).key).toBe("json")
  })

  it("does not call almost-JSON that fails to parse JSON", () => {
    expect(detectSnippetFormat(`{ a: 1, b: 2, }`).key).toBe("text")
  })

  it("detects HTML and XML markup", () => {
    expect(detectSnippetFormat("<!DOCTYPE html>\n<html><body>hi</body></html>").key).toBe("html")
    expect(detectSnippetFormat('<html lang="en"><head></head></html>').key).toBe("html")
    expect(detectSnippetFormat('<?xml version="1.0"?>\n<root><a>1</a></root>').key).toBe("xml")
    expect(detectSnippetFormat("<note><to>x</to><from>y</from></note>").key).toBe("xml")
  })

  it("detects CSV only when delimiter counts are consistent", () => {
    expect(detectSnippetFormat("a,b,c\n1,2,3\n4,5,6").key).toBe("csv")
    expect(detectSnippetFormat("name\temail\tage\nAda\ta@x\t30\nBob\tb@y\t41").key).toBe("csv")
    // Prose lines with stray, uneven commas are not CSV.
    expect(detectSnippetFormat("Hello, there.\nThis line, however, has more.\nAnd this one none").key).toBe("text")
  })

  it("detects markdown only with multiple structural signals", () => {
    const md = "# Title\n\nSome intro text.\n\n- one\n- two\n- three\n\nMore prose here."
    expect(detectSnippetFormat(md).key).toBe("markdown")
    const fenced = "## Setup\n\n```bash\nbun install\nbun run dev\n```\n"
    expect(detectSnippetFormat(fenced).key).toBe("markdown")
    // A single `#`-commented script line is one signal, not markdown.
    const script = "# build script\nset -e\nfor f in *.ts; do\n  echo $f\ndone\n"
    expect(detectSnippetFormat(script).key).not.toBe("markdown")
  })

  it("detects YAML via a document marker or a key-dominated body", () => {
    expect(detectSnippetFormat("---\nname: threa\nversion: 1\nitems:\n  - a\n  - b").key).toBe("yaml")
    expect(detectSnippetFormat("host: localhost\nport: 5432\nuser: admin\ndebug: false").key).toBe("yaml")
    expect(detectSnippetFormat("The quick brown fox.\nJumped over the lazy dog.\nAgain and again.").key).toBe("text")
  })
})

describe("snippetFormatForFilename", () => {
  it("maps known extensions to their format and mime", () => {
    expect(snippetFormatForFilename("snippet-1.json").label).toBe("JSON")
    expect(snippetMimeForFilename("snippet-1.json")).toBe("application/json")
    expect(snippetMimeForFilename("data.csv")).toBe("text/csv")
    expect(snippetMimeForFilename("config.yml")).toBe("application/x-yaml")
    expect(snippetMimeForFilename("page.htm")).toBe("text/html")
    expect(snippetMimeForFilename("notes.md")).toBe("text/markdown")
  })

  it("treats unknown or missing extensions as plain text", () => {
    expect(snippetMimeForFilename("snippet-1.txt")).toBe("text/plain")
    expect(snippetMimeForFilename("mydata")).toBe("text/plain")
    expect(snippetMimeForFilename("archive.unknownext")).toBe("text/plain")
    expect(snippetMimeForFilename(".bashrc")).toBe("text/plain")
  })

  // Guards the "mimes align with categoryFromMime" design claim so a future mime
  // edit can't silently land a snippet in the wrong attachment category.
  it.each([
    ["snippet.json", "code"],
    ["snippet.xml", "code"],
    ["snippet.html", "code"],
    ["snippet.md", "code"],
    ["snippet.yaml", "code"],
    ["snippet.csv", "sheet"],
    ["snippet.txt", "doc"],
  ])("%s mime buckets as %s via categoryFromMime", (filename, category) => {
    expect(categoryFromMime(snippetMimeForFilename(filename))).toBe(category)
  })
})
