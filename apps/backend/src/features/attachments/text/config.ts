import { z } from "zod"
import { TEXT_FORMATS, TEXT_SIZE_TIERS, INJECTION_STRATEGIES } from "@threa/types"

export const TEXT_SUMMARY_MODEL_ID = "openrouter:google/gemini-2.5-flash"

export const TEXT_SUMMARY_TEMPERATURE = 0.3

/**
 * Size thresholds for determining injection strategy.
 * Based on approximate token counts (1 token ~= 4 chars).
 */
export const TEXT_SIZE_THRESHOLDS = {
  /** Small files (<2K tokens, ~8KB): inject complete content */
  smallBytes: 8 * 1024,
  /** Medium files (2K-8K tokens, ~32KB): inject with size note */
  mediumBytes: 32 * 1024,
  /** Large files (>8K tokens, >32KB): summary + sections + read_attachment tool */
} as const

export const BINARY_DETECTION = {
  checkSize: 8 * 1024,
  /** Maximum ratio of null bytes to consider file as text */
  nullByteThreshold: 0.01,
} as const

/**
 * File extension to format mapping.
 * Extensions not in this map will be processed as 'plain' text.
 */
export const EXTENSION_FORMAT_MAP: Record<string, (typeof TEXT_FORMATS)[number]> = {
  // Markdown
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "markdown",
  // JSON
  ".json": "json",
  ".jsonl": "json",
  ".json5": "json",
  // YAML
  ".yaml": "yaml",
  ".yml": "yaml",
  // CSV
  ".csv": "csv",
  ".tsv": "csv",
  // Code - JavaScript/TypeScript
  ".js": "code",
  ".mjs": "code",
  ".cjs": "code",
  ".jsx": "code",
  ".ts": "code",
  ".tsx": "code",
  ".mts": "code",
  ".cts": "code",
  // Code - Python
  ".py": "code",
  ".pyi": "code",
  ".pyx": "code",
  // Code - Go
  ".go": "code",
  // Code - Rust
  ".rs": "code",
  // Code - Java/Kotlin
  ".java": "code",
  ".kt": "code",
  ".kts": "code",
  // Code - C/C++
  ".c": "code",
  ".h": "code",
  ".cpp": "code",
  ".hpp": "code",
  ".cc": "code",
  ".cxx": "code",
  // Code - C#
  ".cs": "code",
  // Code - Ruby
  ".rb": "code",
  ".rake": "code",
  // Code - PHP
  ".php": "code",
  // Code - Swift
  ".swift": "code",
  // Code - Shell
  ".sh": "code",
  ".bash": "code",
  ".zsh": "code",
  // Code - SQL
  ".sql": "code",
  // Code - Other
  ".r": "code",
  ".scala": "code",
  ".clj": "code",
  ".ex": "code",
  ".exs": "code",
  ".erl": "code",
  ".hrl": "code",
  ".hs": "code",
  ".ml": "code",
  ".mli": "code",
  ".fs": "code",
  ".fsx": "code",
  ".lua": "code",
  ".pl": "code",
  ".pm": "code",
  ".vim": "code",
  ".el": "code",
  ".lisp": "code",
  ".scm": "code",
  ".rkt": "code",
}

/** Extension to language name mapping for code files. */
export const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".py": "python",
  ".pyi": "python",
  ".pyx": "cython",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".rake": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "zsh",
  ".sql": "sql",
  ".r": "r",
  ".scala": "scala",
  ".clj": "clojure",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hrl": "erlang",
  ".hs": "haskell",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".fs": "fsharp",
  ".fsx": "fsharp",
  ".lua": "lua",
  ".pl": "perl",
  ".pm": "perl",
  ".vim": "vim",
  ".el": "elisp",
  ".lisp": "lisp",
  ".scm": "scheme",
  ".rkt": "racket",
}

export function getFileExtension(filename: string): string | null {
  const lastDot = filename.lastIndexOf(".")
  if (lastDot === -1 || lastDot === filename.length - 1) {
    return null
  }
  return filename.slice(lastDot).toLowerCase()
}

export const textFormatSchema = z.enum(TEXT_FORMATS)

export const textSizeTierSchema = z.enum(TEXT_SIZE_TIERS)

export const injectionStrategySchema = z.enum(INJECTION_STRATEGIES)

export const textSectionSchema = z.object({
  type: z.enum(["heading", "key", "rows", "lines"]),
  path: z.string(),
  title: z.string(),
  startLine: z.number(),
  endLine: z.number(),
})

export const markdownStructureSchema = z.object({
  toc: z.array(z.string()),
  hasCodeBlocks: z.boolean(),
  hasTables: z.boolean(),
})

export const jsonStructureSchema = z.object({
  rootType: z.enum(["object", "array", "primitive"]),
  topLevelKeys: z.array(z.string()).nullable(),
  arrayLength: z.number().nullable(),
  schemaDescription: z.string().nullable(),
})

export const csvStructureSchema = z.object({
  headers: z.array(z.string()),
  rowCount: z.number(),
  sampleRows: z.array(z.array(z.string())),
})

export const codeStructureSchema = z.object({
  language: z.string(),
  exports: z.array(z.string()).nullable(),
  imports: z.array(z.string()).nullable(),
})

export const textMetadataSchema = z.object({
  format: textFormatSchema,
  sizeTier: textSizeTierSchema,
  injectionStrategy: injectionStrategySchema,
  totalLines: z.number(),
  totalBytes: z.number(),
  encoding: z.string(),
  sections: z.array(textSectionSchema),
  structure: z
    .union([markdownStructureSchema, jsonStructureSchema, csvStructureSchema, codeStructureSchema])
    .nullable(),
})

export type TextMetadataOutput = z.infer<typeof textMetadataSchema>

export const textSummarySchema = z.object({
  summary: z.string().describe("2-3 sentence summary of the file content"),
  keyTopics: z.array(z.string()).describe("Main topics or concepts covered"),
})

export type TextSummaryOutput = z.infer<typeof textSummarySchema>

export const TEXT_SUMMARY_SYSTEM_PROMPT = `You are a document summarization specialist. Analyze the provided text content and create a structured summary.

Guidelines:
- Write a 2-3 sentence summary capturing the main purpose and content
- List key topics or concepts covered
- Be factual and concise
- Focus on information that would help someone understand what the file contains without reading it`

export const TEXT_SUMMARY_USER_PROMPT = `Summarize this text file. The file is named "{filename}" and contains {totalLines} lines.

Content preview (first section):
{contentPreview}`
