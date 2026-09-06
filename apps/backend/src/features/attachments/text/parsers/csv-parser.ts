import type { TextSection, CsvStructure } from "@threahq/types"
import type { ParseResult, TextParser } from "./types"
import { buildPreview } from "./preview"

const PREVIEW_LINES = 50
const SAMPLE_ROWS = 5
const ROWS_PER_SECTION = 100

export const csvParser: TextParser = {
  parse(content: string, filename: string): ParseResult {
    const lines = content.split("\n").filter((line) => line.trim().length > 0)
    const totalLines = lines.length

    if (lines.length === 0) {
      return {
        format: "csv",
        sections: [],
        structure: null,
        previewContent: "",
        totalLines: 0,
      }
    }

    const firstLine = lines[0]
    const delimiter = filename.toLowerCase().endsWith(".tsv") || firstLine.includes("\t") ? "\t" : ","

    const headers = parseCsvLine(firstLine, delimiter)

    const sampleRows: string[][] = []
    for (let i = 1; i < Math.min(lines.length, SAMPLE_ROWS + 1); i++) {
      sampleRows.push(parseCsvLine(lines[i], delimiter))
    }

    const sections: TextSection[] = []
    const dataRows = lines.length - 1 // Exclude header

    if (dataRows > ROWS_PER_SECTION) {
      let rowStart = 1 // Start after header
      while (rowStart <= dataRows) {
        const rowEnd = Math.min(rowStart + ROWS_PER_SECTION - 1, dataRows)
        sections.push({
          type: "rows",
          path: `${rowStart}-${rowEnd}`,
          title: `Rows ${rowStart}-${rowEnd}`,
          startLine: rowStart,
          endLine: rowEnd + 1, // +1 for exclusive end
        })
        rowStart = rowEnd + 1
      }
    }

    const structure: CsvStructure = {
      headers,
      rowCount: dataRows,
      sampleRows,
    }

    return {
      format: "csv",
      sections,
      structure,
      previewContent: buildPreview(lines, PREVIEW_LINES),
      totalLines,
    }
  },
}

/**
 * Parse a single CSV line, handling quoted fields.
 */
function parseCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = []
  let current = ""
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    const nextChar = line[i + 1]

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote ("").
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(current.trim())
      current = ""
    } else {
      current += char
    }
  }

  result.push(current.trim())
  return result
}
