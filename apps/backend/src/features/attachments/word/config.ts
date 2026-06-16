import { z } from "zod"
import { TEXT_SIZE_TIERS, INJECTION_STRATEGIES } from "@threa/types"

export const WORD_SUMMARY_MODEL_ID = "openrouter:google/gemini-2.5-flash"

export const WORD_SUMMARY_TEMPERATURE = 0.3

export const WORD_IMAGE_CAPTION_MODEL_ID = "openrouter:google/gemini-2.5-flash"

export const WORD_IMAGE_CAPTION_TEMPERATURE = 0.1

export const WORD_MIME_TYPES = [
  "application/msword", // .doc
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
] as const

export const WORD_EXTENSIONS = [".doc", ".docx"] as const

export const WORD_MAGIC_BYTES = {
  /** DOCX: ZIP archive starting with PK (0x50 0x4B) */
  docx: [0x50, 0x4b, 0x03, 0x04] as const,
  /** DOC: OLE compound document */
  doc: [0xd0, 0xcf, 0x11, 0xe0] as const,
} as const

/**
 * Byte thresholds approximate token counts (1 token ~= 4 chars); kept in sync
 * with text processing for consistent injection strategy across file types.
 */
export const WORD_SIZE_THRESHOLDS = {
  smallBytes: 8 * 1024,
  mediumBytes: 32 * 1024,
} as const

/**
 * Treats "application/octet-stream" as Word when the extension matches, since
 * some clients upload documents with a generic MIME type.
 */
export function isWordAttachment(mimeType: string, filename: string): boolean {
  if (WORD_MIME_TYPES.includes(mimeType as (typeof WORD_MIME_TYPES)[number])) {
    return true
  }

  if (mimeType === "application/octet-stream") {
    const lowerFilename = filename.toLowerCase()
    return WORD_EXTENSIONS.some((ext) => lowerFilename.endsWith(ext))
  }

  return false
}

export function getFileExtension(filename: string): string | null {
  const lastDot = filename.lastIndexOf(".")
  if (lastDot === -1 || lastDot === filename.length - 1) {
    return null
  }
  return filename.slice(lastDot).toLowerCase()
}

export const wordFormatSchema = z.enum(["docx", "doc"])

export const sizeTierSchema = z.enum(TEXT_SIZE_TIERS)

export const injectionStrategySchema = z.enum(INJECTION_STRATEGIES)

/**
 * Reused from text processing.
 */
export const textSectionSchema = z.object({
  type: z.enum(["heading", "key", "rows", "lines"]),
  path: z.string(),
  title: z.string(),
  startLine: z.number(),
  endLine: z.number(),
})

export const wordMetadataSchema = z.object({
  format: wordFormatSchema,
  sizeTier: sizeTierSchema,
  injectionStrategy: injectionStrategySchema,
  pageCount: z.number().nullable(),
  wordCount: z.number(),
  characterCount: z.number(),
  author: z.string().nullable(),
  createdAt: z.string().nullable(),
  modifiedAt: z.string().nullable(),
  embeddedImageCount: z.number(),
  sections: z.array(textSectionSchema),
})

export type WordMetadataOutput = z.infer<typeof wordMetadataSchema>

export const wordSummarySchema = z.object({
  summary: z.string().describe("2-3 sentence summary of the document content"),
  keyTopics: z.array(z.string()).describe("Main topics or concepts covered"),
})

export type WordSummaryOutput = z.infer<typeof wordSummarySchema>

export const embeddedImageCaptionSchema = z.object({
  caption: z.string().describe("Brief description of the image content"),
})

export type EmbeddedImageCaptionOutput = z.infer<typeof embeddedImageCaptionSchema>

export const WORD_SUMMARY_SYSTEM_PROMPT = `You are a document summarization specialist. Analyze the provided Word document content and create a structured summary.

Guidelines:
- Write a 2-3 sentence summary capturing the main purpose and content
- List key topics or concepts covered
- Be factual and concise
- Focus on information that would help someone understand what the document contains without reading it`

export const WORD_SUMMARY_USER_PROMPT = `Summarize this Word document. The file is named "{filename}" and contains approximately {wordCount} words.

Content preview (first section):
{contentPreview}`

export const EMBEDDED_IMAGE_CAPTION_SYSTEM_PROMPT = `You are an image analysis specialist. Provide a brief, factual description of the image content that would help someone understand what the image shows in the context of a document.

Guidelines:
- Write a single sentence describing the image
- Focus on the main subject or content
- Be specific and factual
- Keep it concise (under 50 words)`

export const EMBEDDED_IMAGE_CAPTION_USER_PROMPT = `Describe this image briefly.`
