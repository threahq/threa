import { describe, test, expect } from "bun:test"
import { getParser } from "./index"
import { PREVIEW_MAX_CHARS } from "./preview"

describe("plainTextParser", () => {
  const parser = getParser("plain")

  test("should parse simple text content", () => {
    const content = "Line 1\nLine 2\nLine 3"
    const result = parser.parse(content, "file.txt")

    expect(result.format).toBe("plain")
    expect(result.totalLines).toBe(3)
    expect(result.structure).toBeNull()
  })

  test("should create sections for large files", () => {
    const lines = Array.from({ length: 250 }, (_, i) => `Line ${i + 1}`)
    const content = lines.join("\n")
    const result = parser.parse(content, "large.txt")

    expect(result.sections.length).toBe(3) // 250 lines / 100 per section
    expect(result.sections[0].type).toBe("lines")
    expect(result.sections[0].path).toBe("0-99")
    expect(result.sections[1].path).toBe("100-199")
    expect(result.sections[2].path).toBe("200-249")
  })
})

describe("markdownParser", () => {
  const parser = getParser("markdown")

  test("should extract headings", () => {
    const content = `# Title

Some intro text.

## Section 1

Content for section 1.

## Section 2

Content for section 2.

### Subsection 2.1

More content.`

    const result = parser.parse(content, "readme.md")

    expect(result.format).toBe("markdown")
    expect(result.sections.length).toBe(4)
    expect(result.sections[0].title).toBe("Title")
    expect(result.sections[1].title).toBe("Section 1")
    expect(result.sections[2].title).toBe("Section 2")
    expect(result.sections[3].title).toBe("Subsection 2.1")
  })

  test("should detect code blocks", () => {
    const content = `# Example

\`\`\`javascript
console.log("hello");
\`\`\``

    const result = parser.parse(content, "example.md")

    expect(result.structure).not.toBeNull()
    if (result.structure && "hasCodeBlocks" in result.structure) {
      expect(result.structure.hasCodeBlocks).toBe(true)
    }
  })

  test("should build TOC", () => {
    const content = `# Main
## Sub1
## Sub2
### Sub2a`

    const result = parser.parse(content, "doc.md")

    expect(result.structure).not.toBeNull()
    if (result.structure && "toc" in result.structure) {
      expect(result.structure.toc).toHaveLength(4)
      expect(result.structure.toc[0]).toBe("Main")
      expect(result.structure.toc[1]).toBe("  Sub1")
      expect(result.structure.toc[2]).toBe("  Sub2")
      expect(result.structure.toc[3]).toBe("    Sub2a")
    }
  })
})

describe("jsonParser", () => {
  const parser = getParser("json")

  test("should parse object structure", () => {
    const content = JSON.stringify({ name: "test", value: 123, nested: { key: "val" } }, null, 2)
    const result = parser.parse(content, "config.json")

    expect(result.format).toBe("json")
    expect(result.structure).not.toBeNull()
    if (result.structure && "rootType" in result.structure) {
      expect(result.structure.rootType).toBe("object")
      expect(result.structure.topLevelKeys).toContain("name")
      expect(result.structure.topLevelKeys).toContain("value")
      expect(result.structure.topLevelKeys).toContain("nested")
    }
  })

  test("should parse array structure", () => {
    const content = JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }])
    const result = parser.parse(content, "data.json")

    expect(result.structure).not.toBeNull()
    if (result.structure && "rootType" in result.structure) {
      expect(result.structure.rootType).toBe("array")
      expect(result.structure.arrayLength).toBe(3)
    }
  })

  test("should handle invalid JSON gracefully", () => {
    const content = "{ invalid json"
    const result = parser.parse(content, "broken.json")

    expect(result.format).toBe("json")
    expect(result.structure).toBeNull()
  })
})

describe("yamlParser", () => {
  const parser = getParser("yaml")

  test("should parse YAML object", () => {
    const content = `name: test
version: 1.0
dependencies:
  - foo
  - bar`

    const result = parser.parse(content, "config.yaml")

    expect(result.format).toBe("yaml")
    expect(result.structure).not.toBeNull()
    if (result.structure && "rootType" in result.structure) {
      expect(result.structure.rootType).toBe("object")
      expect(result.structure.topLevelKeys).toContain("name")
      expect(result.structure.topLevelKeys).toContain("version")
    }
  })
})

describe("csvParser", () => {
  const parser = getParser("csv")

  test("should extract headers and row count", () => {
    const content = `name,age,city
Alice,30,NYC
Bob,25,LA
Charlie,35,Chicago`

    const result = parser.parse(content, "data.csv")

    expect(result.format).toBe("csv")
    expect(result.structure).not.toBeNull()
    if (result.structure && "headers" in result.structure) {
      expect(result.structure.headers).toEqual(["name", "age", "city"])
      expect(result.structure.rowCount).toBe(3)
      expect(result.structure.sampleRows.length).toBe(3)
    }
  })

  test("should handle quoted fields", () => {
    const content = `name,description
"Alice","Hello, World"
"Bob","Quote: ""test"""`

    const result = parser.parse(content, "data.csv")

    expect(result.structure).not.toBeNull()
    if (result.structure && "sampleRows" in result.structure) {
      expect(result.structure.sampleRows[0][1]).toBe("Hello, World")
      expect(result.structure.sampleRows[1][1]).toBe('Quote: "test"')
    }
  })
})

describe("codeParser", () => {
  const parser = getParser("code")

  test("should detect TypeScript language", () => {
    const content = `import { foo } from "./foo"

export function bar() {
  return foo()
}

export const baz = 123`

    const result = parser.parse(content, "module.ts")

    expect(result.format).toBe("code")
    expect(result.structure).not.toBeNull()
    if (result.structure && "language" in result.structure) {
      expect(result.structure.language).toBe("typescript")
      expect(result.structure.imports).toContain('"./foo"')
      expect(result.structure.exports).toContain("bar")
      expect(result.structure.exports).toContain("baz")
    }
  })

  test("should detect Python language", () => {
    const content = `import os
from pathlib import Path

def main():
    pass

class Foo:
    pass`

    const result = parser.parse(content, "main.py")

    expect(result.structure).not.toBeNull()
    if (result.structure && "language" in result.structure) {
      expect(result.structure.language).toBe("python")
      expect(result.structure.imports).toContain("import os")
      expect(result.structure.exports).toContain("main")
      expect(result.structure.exports).toContain("Foo")
    }
  })

  test("should detect Go language", () => {
    const content = `package main

import "fmt"

func Main() {
    fmt.Println("Hello")
}`

    const result = parser.parse(content, "main.go")

    expect(result.structure).not.toBeNull()
    if (result.structure && "language" in result.structure) {
      expect(result.structure.language).toBe("go")
      expect(result.structure.imports).toContain("fmt")
      expect(result.structure.exports).toContain("Main")
    }
  })
})

describe("preview bounds", () => {
  // A line budget alone bounds nothing: minified HTML/JSON and single-line log
  // dumps put a whole file on one line. Production sent 278,480 prompt tokens
  // for one such HTML file before the character cap existed.
  const oneLongLine = "x".repeat(500_000)

  test("caps a single enormous line at the character ceiling", () => {
    const result = getParser("plain").parse(oneLongLine, "minified.html")

    expect(result.previewContent.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS + 32)
    expect(result.previewContent.endsWith("…[preview truncated]")).toBe(true)
  })

  test("caps every format, not just the one that was reported", () => {
    const cases: Array<[Parameters<typeof getParser>[0], string]> = [
      ["plain", "minified.html"],
      ["json", "logs.json"],
      ["csv", "rows.csv"],
      ["yaml", "config.yaml"],
      ["markdown", "notes.md"],
      ["code", "bundle.js"],
    ]

    for (const [format, filename] of cases) {
      const result = getParser(format).parse(oneLongLine, filename)
      expect({ format, over: result.previewContent.length > PREVIEW_MAX_CHARS + 32 }).toEqual({ format, over: false })
    }
  })

  test("leaves a preview that fits untouched", () => {
    const content = "Line 1\nLine 2\nLine 3"
    const result = getParser("plain").parse(content, "file.txt")

    expect(result.previewContent).toBe(content)
  })
})
