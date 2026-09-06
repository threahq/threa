import type { TextSection, MarkdownStructure } from "@threahq/types"
import type { ParseResult, TextParser } from "./types"
import { buildPreview } from "./preview"

const PREVIEW_LINES = 100

interface HeadingInfo {
  level: number
  text: string
  lineNumber: number
}

export const markdownParser: TextParser = {
  parse(content: string, _filename: string): ParseResult {
    const lines = content.split("\n")
    const totalLines = lines.length

    const headings: HeadingInfo[] = []
    let hasCodeBlocks = false
    let hasTables = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
      if (headingMatch) {
        headings.push({
          level: headingMatch[1].length,
          text: headingMatch[2].trim(),
          lineNumber: i,
        })
      }

      if (line.startsWith("```")) {
        hasCodeBlocks = true
      }

      if (line.includes("|") && !line.startsWith("|---")) {
        const pipeCount = (line.match(/\|/g) || []).length
        if (pipeCount >= 2) {
          hasTables = true
        }
      }
    }

    const toc = headings.map((h) => {
      const indent = "  ".repeat(h.level - 1)
      return `${indent}${h.text}`
    })

    const sections: TextSection[] = []
    for (let i = 0; i < headings.length; i++) {
      const current = headings[i]
      const next = headings[i + 1]
      const endLine = next ? next.lineNumber : totalLines

      // Walk back to ancestor headings of lower level to build a nested path.
      const ancestors: string[] = []
      for (let j = i - 1; j >= 0; j--) {
        if (headings[j].level < current.level) {
          ancestors.unshift(headings[j].text)
          if (headings[j].level === 1) break
        }
      }
      const path = [...ancestors, current.text].join(" > ")

      sections.push({
        type: "heading",
        path,
        title: current.text,
        startLine: current.lineNumber,
        endLine,
      })
    }

    const previewContent = buildPreview(lines, PREVIEW_LINES)

    const structure: MarkdownStructure = {
      toc,
      hasCodeBlocks,
      hasTables,
    }

    return {
      format: "markdown",
      sections,
      structure,
      previewContent,
      totalLines,
    }
  },
}
