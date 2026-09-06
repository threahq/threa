import type { Pool } from "pg"
import type { TextSizeTier, InjectionStrategy, TextSection, WordMetadata } from "@threahq/types"
import type { StorageProvider } from "../../../lib/storage/s3-client"
import type { AI } from "@threahq/agent-runtime"
import { TextSizeTiers, InjectionStrategies } from "@threahq/types"
import { logger } from "../../../lib/logger"
import { processAttachment, type ExtractionData } from "../process-attachment"
import {
  WORD_SIZE_THRESHOLDS,
  WORD_SUMMARY_MODEL_ID,
  WORD_SUMMARY_TEMPERATURE,
  WORD_SUMMARY_SYSTEM_PROMPT,
  WORD_SUMMARY_USER_PROMPT,
  WORD_IMAGE_CAPTION_MODEL_ID,
  WORD_IMAGE_CAPTION_TEMPERATURE,
  EMBEDDED_IMAGE_CAPTION_SYSTEM_PROMPT,
  EMBEDDED_IMAGE_CAPTION_USER_PROMPT,
  wordSummarySchema,
  embeddedImageCaptionSchema,
} from "./config"
import { validateWordFormat, type WordFormat } from "./detector"
import { extractWord, type ExtractedImage } from "./extractor"
import type { WordProcessingServiceLike } from "./types"

export interface WordProcessingServiceDeps {
  pool: Pool
  ai: AI
  storage: StorageProvider
}

export class WordProcessingService implements WordProcessingServiceLike {
  private readonly pool: Pool
  private readonly ai: AI
  private readonly storage: StorageProvider

  constructor(deps: WordProcessingServiceDeps) {
    this.pool = deps.pool
    this.ai = deps.ai
    this.storage = deps.storage
  }

  async processWord(attachmentId: string): Promise<void> {
    const log = logger.child({ attachmentId })

    await processAttachment(this.pool, attachmentId, async (attachment): Promise<ExtractionData | null> => {
      log.info({ filename: attachment.filename, mimeType: attachment.mimeType }, "Processing Word document")

      try {
        const fileBuffer = await this.storage.getObject(attachment.storagePath)

        const format = validateWordFormat(fileBuffer)
        log.info({ format }, "Word format detected")

        const extracted = await extractWord(fileBuffer, format)
        const textContent = extracted.text

        let processedImageCaptions: string[] = []
        if (extracted.images.length > 0) {
          log.info({ imageCount: extracted.images.length }, "Processing embedded images")
          processedImageCaptions = await this.captionEmbeddedImages(
            extracted.images,
            attachment.workspaceId,
            attachmentId
          )
        }

        const contentWithImages = this.integrateImageCaptions(textContent, processedImageCaptions)

        const wordCount = countWords(textContent)
        const characterCount = textContent.length
        const contentBytes = Buffer.byteLength(contentWithImages, "utf-8")

        const sizeTier = determineSizeTier(contentBytes)
        const injectionStrategy = determineInjectionStrategy(sizeTier)

        const sections = buildSections(textContent)

        const wordMetadata: WordMetadata = {
          format,
          sizeTier,
          injectionStrategy,
          pageCount: extracted.properties.pageCount,
          wordCount,
          characterCount,
          author: extracted.properties.author,
          createdAt: extracted.properties.createdAt?.toISOString() ?? null,
          modifiedAt: extracted.properties.modifiedAt?.toISOString() ?? null,
          embeddedImageCount: extracted.images.length,
          sections,
        }

        let summary: string
        let fullTextToStore: string | null

        if (sizeTier === TextSizeTiers.LARGE) {
          fullTextToStore = null

          const contentPreview = textContent.slice(0, 4000)
          const summaryResult = await this.ai.generateObject({
            model: WORD_SUMMARY_MODEL_ID,
            schema: wordSummarySchema,
            temperature: WORD_SUMMARY_TEMPERATURE,
            messages: [
              { role: "system", content: WORD_SUMMARY_SYSTEM_PROMPT },
              {
                role: "user",
                content: WORD_SUMMARY_USER_PROMPT.replace("{filename}", attachment.filename)
                  .replace("{wordCount}", String(wordCount))
                  .replace("{contentPreview}", contentPreview),
              },
            ],
            telemetry: {
              functionId: "word-summary",
              metadata: {
                attachment_id: attachmentId,
                workspace_id: attachment.workspaceId,
                filename: attachment.filename,
                format,
                size_tier: sizeTier,
              },
            },
            context: {
              workspaceId: attachment.workspaceId,
            },
          })

          summary = summaryResult.value.summary
          log.info({ format, sizeTier, summaryLength: summary.length }, "Word summary generated")
        } else {
          fullTextToStore = contentWithImages
          summary = generateSimpleSummary(
            attachment.filename,
            format,
            wordCount,
            characterCount,
            extracted.images.length
          )
        }

        return {
          contentType: "document" as const,
          summary,
          fullText: fullTextToStore,
          structuredData: null,
          sourceType: "word" as const,
          wordMetadata,
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        if (errorMessage.includes("password") || errorMessage.includes("encrypted")) {
          log.info({ filename: attachment.filename }, "Password-protected document, marking as skipped")
          return null
        }

        log.error({ error }, "Word processing failed")
        throw error
      }
    })
  }

  private async captionEmbeddedImages(
    images: ExtractedImage[],
    workspaceId: string,
    attachmentId: string
  ): Promise<string[]> {
    const captions: string[] = []

    for (const image of images) {
      try {
        // Skip non-standard image formats that models may not handle well
        if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(image.mimeType)) {
          captions.push(`Embedded ${image.mimeType.split("/")[1]} image`)
          continue
        }

        const result = await this.ai.generateObject({
          model: WORD_IMAGE_CAPTION_MODEL_ID,
          schema: embeddedImageCaptionSchema,
          temperature: WORD_IMAGE_CAPTION_TEMPERATURE,
          messages: [
            { role: "system", content: EMBEDDED_IMAGE_CAPTION_SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                { type: "text", text: EMBEDDED_IMAGE_CAPTION_USER_PROMPT },
                {
                  type: "image",
                  image: image.data,
                  mimeType: image.mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
                },
              ],
            },
          ],
          telemetry: {
            functionId: "word-image-caption",
            metadata: {
              attachment_id: attachmentId,
              workspace_id: workspaceId,
              image_index: image.index,
            },
          },
          context: {
            workspaceId,
          },
        })

        captions.push(result.value.caption)
      } catch (error) {
        logger.warn({ error, imageIndex: image.index }, "Failed to caption embedded image")
        captions.push("Unable to process")
      }
    }

    return captions
  }

  private integrateImageCaptions(text: string, captions: string[]): string {
    if (captions.length === 0) {
      return text
    }

    const imageSection = captions.map((caption, i) => `[Image ${i + 1}: ${caption}]`).join("\n")
    return `${text}\n\n--- Embedded Images ---\n${imageSection}`
  }
}

function determineSizeTier(totalBytes: number): TextSizeTier {
  if (totalBytes <= WORD_SIZE_THRESHOLDS.smallBytes) {
    return TextSizeTiers.SMALL
  }
  if (totalBytes <= WORD_SIZE_THRESHOLDS.mediumBytes) {
    return TextSizeTiers.MEDIUM
  }
  return TextSizeTiers.LARGE
}

function determineInjectionStrategy(sizeTier: TextSizeTier): InjectionStrategy {
  switch (sizeTier) {
    case TextSizeTiers.SMALL:
      return InjectionStrategies.FULL
    case TextSizeTiers.MEDIUM:
      return InjectionStrategies.FULL_WITH_NOTE
    case TextSizeTiers.LARGE:
      return InjectionStrategies.SUMMARY
  }
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length
}

function buildSections(text: string): TextSection[] {
  const sections: TextSection[] = []
  const lines = text.split("\n")

  let currentSection: TextSection | null = null
  let lineNumber = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    lineNumber++

    if (!line) continue

    const isHeading =
      (line.length < 80 && line.length > 2 && !line.endsWith(".") && !line.endsWith(",")) ||
      (line === line.toUpperCase() && line.length > 3 && /[A-Z]/.test(line)) ||
      /^\d+\.?\s+[A-Z]/.test(line)

    if (isHeading) {
      if (currentSection) {
        currentSection.endLine = lineNumber - 1
        if (currentSection.endLine > currentSection.startLine) {
          sections.push(currentSection)
        }
      }

      currentSection = {
        type: "heading",
        path: line.slice(0, 100),
        title: line.slice(0, 100),
        startLine: lineNumber,
        endLine: lineNumber,
      }
    }
  }

  if (currentSection) {
    currentSection.endLine = lineNumber
    if (currentSection.endLine > currentSection.startLine) {
      sections.push(currentSection)
    }
  }

  return sections
}

function generateSimpleSummary(
  filename: string,
  format: WordFormat,
  wordCount: number,
  characterCount: number,
  imageCount: number
): string {
  const formatDesc = format === "docx" ? "Word document" : "Legacy Word document"
  const sizeDesc = characterCount < 1024 ? `${characterCount} characters` : `${Math.round(characterCount / 1024)}KB`

  let summary = `${formatDesc} "${filename}" (${wordCount} words, ${sizeDesc})`

  if (imageCount > 0) {
    summary += ` with ${imageCount} embedded image${imageCount > 1 ? "s" : ""}`
  }

  return summary + "."
}
