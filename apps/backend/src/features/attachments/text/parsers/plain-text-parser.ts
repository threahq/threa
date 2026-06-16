/**
 * Plain Text Parser
 *
 * Fallback parser for all text files that don't match a specialized format.
 * Handles: .txt, .log, .cfg, .ini, .env, and any unrecognized text files.
 */

import type { TextSection } from "@threa/types"
import type { ParseResult, TextParser } from "./types"

const PREVIEW_LINES = 100
const SECTION_SIZE = 100 // Lines per section for large files

export const plainTextParser: TextParser = {
  parse(content: string, _filename: string): ParseResult {
    const lines = content.split("\n")
    const totalLines = lines.length

    const sections: TextSection[] = []

    if (totalLines > SECTION_SIZE) {
      let sectionStart = 0
      while (sectionStart < totalLines) {
        const sectionEnd = Math.min(sectionStart + SECTION_SIZE, totalLines)
        sections.push({
          type: "lines",
          path: `${sectionStart}-${sectionEnd - 1}`,
          title: `Lines ${sectionStart + 1}-${sectionEnd}`,
          startLine: sectionStart,
          endLine: sectionEnd,
        })
        sectionStart = sectionEnd
      }
    }

    const previewContent = lines.slice(0, PREVIEW_LINES).join("\n")

    return {
      format: "plain",
      sections,
      structure: null,
      previewContent,
      totalLines,
    }
  },
}
