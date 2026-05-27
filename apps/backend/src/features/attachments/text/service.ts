/**
 * Text Processing Service
 *
 * Processes text-based attachments to extract structured information
 * that can be used by AI agents to understand file content.
 */

import type { Pool } from "pg"
import type { TextFormat, TextSizeTier, InjectionStrategy, TextMetadata } from "@threa/types"
import type { StorageProvider } from "../../../lib/storage/s3-client"
import type { AI } from "@threa/agent-runtime"
import { TextSizeTiers, InjectionStrategies } from "@threa/types"
import { logger } from "../../../lib/logger"
import { processAttachment } from "../process-attachment"
import {
  TEXT_SIZE_THRESHOLDS,
  TEXT_SUMMARY_MODEL_ID,
  TEXT_SUMMARY_TEMPERATURE,
  TEXT_SUMMARY_SYSTEM_PROMPT,
  TEXT_SUMMARY_USER_PROMPT,
  BINARY_DETECTION,
  textSummarySchema,
} from "./config"
import { isBinaryFile, normalizeEncoding, inferFormat } from "./detector"
import { getParser } from "./parsers"
import type { TextProcessingServiceLike } from "./types"

export interface TextProcessingServiceDeps {
  pool: Pool
  ai: AI
  storage: StorageProvider
}

export class TextProcessingService implements TextProcessingServiceLike {
  private readonly pool: Pool
  private readonly ai: AI
  private readonly storage: StorageProvider

  constructor(deps: TextProcessingServiceDeps) {
    this.pool = deps.pool
    this.ai = deps.ai
    this.storage = deps.storage
  }

  async processText(attachmentId: string): Promise<void> {
    const log = logger.child({ attachmentId })

    await processAttachment(this.pool, attachmentId, async (attachment) => {
      log.info({ filename: attachment.filename, mimeType: attachment.mimeType }, "Processing text attachment")

      // Fetch first 8KB for binary detection (avoid downloading full file for binaries)
      const headBuffer = await this.storage.getObjectRange(attachment.storagePath, 0, BINARY_DETECTION.checkSize - 1)

      if (isBinaryFile(headBuffer)) {
        log.info({ filename: attachment.filename }, "File detected as binary, marking as skipped")
        return null
      }

      try {
        // Download full content
        const fileBuffer = await this.storage.getObject(attachment.storagePath)

        // Normalize encoding to UTF-8
        const normalized = normalizeEncoding(fileBuffer)
        const textContent = normalized.text
        const encoding = normalized.encoding

        // Infer format from filename and content
        const format = inferFormat(attachment.filename, textContent)

        // Parse using format-specific parser
        const parser = getParser(format)
        const parseResult = parser.parse(textContent, attachment.filename)

        // Determine size tier and injection strategy
        const totalBytes = fileBuffer.length
        const sizeTier = determineSizeTier(totalBytes)
        const injectionStrategy = determineInjectionStrategy(sizeTier)

        // Build text metadata
        const textMetadata: TextMetadata = {
          format: parseResult.format,
          sizeTier,
          injectionStrategy,
          totalLines: parseResult.totalLines,
          totalBytes,
          encoding,
          sections: parseResult.sections,
          structure: parseResult.structure,
        }

        // Determine what to store and summarize
        let summary: string
        let fullTextToStore: string | null

        if (sizeTier === TextSizeTiers.LARGE) {
          fullTextToStore = null

          const summaryResult = await this.ai.generateObject({
            model: TEXT_SUMMARY_MODEL_ID,
            schema: textSummarySchema,
            temperature: TEXT_SUMMARY_TEMPERATURE,
            messages: [
              { role: "system", content: TEXT_SUMMARY_SYSTEM_PROMPT },
              {
                role: "user",
                content: TEXT_SUMMARY_USER_PROMPT.replace("{filename}", attachment.filename)
                  .replace("{totalLines}", String(parseResult.totalLines))
                  .replace("{contentPreview}", parseResult.previewContent),
              },
            ],
            telemetry: {
              functionId: "text-summary",
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
          log.info({ format, sizeTier, summaryLength: summary.length }, "Text summary generated")
        } else {
          fullTextToStore = textContent
          summary = generateSimpleSummary(
            attachment.filename,
            format,
            parseResult.totalLines,
            totalBytes,
            parseResult.structure
          )
        }

        return {
          contentType: "document" as const,
          summary,
          fullText: fullTextToStore,
          structuredData: null,
          sourceType: "text" as const,
          textMetadata,
        }
      } catch (error) {
        log.error({ error }, "Text processing failed")
        throw error
      }
    })
  }
}

function determineSizeTier(totalBytes: number): TextSizeTier {
  if (totalBytes <= TEXT_SIZE_THRESHOLDS.smallBytes) {
    return TextSizeTiers.SMALL
  }
  if (totalBytes <= TEXT_SIZE_THRESHOLDS.mediumBytes) {
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

function generateSimpleSummary(
  filename: string,
  format: TextFormat,
  totalLines: number,
  totalBytes: number,
  structure: TextMetadata["structure"]
): string {
  const sizeDesc = totalBytes < 1024 ? `${totalBytes} bytes` : `${Math.round(totalBytes / 1024)}KB`

  let formatDesc: string
  switch (format) {
    case "markdown":
      formatDesc = "Markdown document"
      break
    case "json":
      formatDesc = "JSON data file"
      break
    case "yaml":
      formatDesc = "YAML configuration file"
      break
    case "csv":
      formatDesc = "CSV spreadsheet"
      break
    case "code":
      formatDesc = structure && "language" in structure ? `${structure.language} source code` : "Source code"
      break
    default:
      formatDesc = "Plain text file"
  }

  let structureDesc = ""
  if (structure) {
    if ("toc" in structure && structure.toc.length > 0) {
      structureDesc = ` with ${structure.toc.length} sections`
    } else if ("headers" in structure) {
      structureDesc = ` with ${structure.headers.length} columns and ${structure.rowCount} rows`
    } else if ("topLevelKeys" in structure && structure.topLevelKeys) {
      structureDesc = ` containing ${structure.topLevelKeys.length} top-level keys`
    } else if ("arrayLength" in structure && structure.arrayLength !== null) {
      structureDesc = ` containing ${structure.arrayLength} items`
    } else if ("exports" in structure && structure.exports) {
      structureDesc = ` defining ${structure.exports.length} exports`
    }
  }

  return `${formatDesc} "${filename}" (${totalLines} lines, ${sizeDesc})${structureDesc}.`
}
