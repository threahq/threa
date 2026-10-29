import { describe, test, expect } from "bun:test"
import { docFirstLine } from "./hosted-docs"

describe("docFirstLine", () => {
  test.each([
    ["the first non-blank line, trimmed", "\n   \n  ## Q4 tracker  \nsecond line", "## Q4 tracker"],
    ["the raw markdown of the line", "- [ ] Ship **docs**", "- [ ] Ship **docs**"],
    ["null for a blank section", " \n\t\n", null],
    ["null for a doc with no section", undefined, null],
    ["the line capped at 120 characters", "x".repeat(130), `${"x".repeat(120)}…`],
    ["the line before a hard break, without its backslash", "AWS row\\\nsecond line", "AWS row"],
    ["an escaped backslash ending the line as one backslash", "C:\\\\\nnext", "C:\\"],
  ])("returns %s", (_name, markdown, expected) => {
    expect(docFirstLine(markdown)).toBe(expected)
  })
})
