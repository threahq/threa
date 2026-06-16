import type {
  TextFormat,
  TextSection,
  MarkdownStructure,
  JsonStructure,
  CsvStructure,
  CodeStructure,
} from "@threa/types"

export interface ParseResult {
  format: TextFormat
  sections: TextSection[]
  /** Format-specific structure (null for plain text). */
  structure: MarkdownStructure | JsonStructure | CsvStructure | CodeStructure | null
  /** Preview content for summarization (first N lines). */
  previewContent: string
  totalLines: number
}

export interface TextParser {
  parse(content: string, filename: string): ParseResult
}
