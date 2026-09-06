import type { Pool } from "pg"
import type { ExcelMetadata, TextSizeTier, InjectionStrategy, ExcelSheetInfo, ExcelChartInfo } from "@threahq/types"
import type { AI } from "@threahq/agent-runtime"
import type { StorageProvider } from "../../../lib/storage/s3-client"
import { TextSizeTiers, InjectionStrategies } from "@threahq/types"
import { logger } from "../../../lib/logger"
import { processAttachment, type ExtractionData } from "../process-attachment"
import {
  EXCEL_SIZE_THRESHOLDS,
  EXCEL_SHEET_THRESHOLDS,
  EXCEL_SUMMARY_MODEL_ID,
  EXCEL_SUMMARY_TEMPERATURE,
  EXCEL_SUMMARY_SYSTEM_PROMPT,
  EXCEL_SUMMARY_USER_PROMPT,
  excelSummarySchema,
} from "./config"
import { validateExcelFormat, type ExcelFormat } from "./detector"
import { extractExcel, type ExtractedSheet } from "./extractor"
import type { ExcelProcessingServiceLike } from "./types"

export interface ExcelProcessingServiceDeps {
  pool: Pool
  ai: AI
  storage: StorageProvider
}

export class ExcelProcessingService implements ExcelProcessingServiceLike {
  private readonly pool: Pool
  private readonly ai: AI
  private readonly storage: StorageProvider

  constructor(deps: ExcelProcessingServiceDeps) {
    this.pool = deps.pool
    this.ai = deps.ai
    this.storage = deps.storage
  }

  async processExcel(attachmentId: string): Promise<void> {
    const log = logger.child({ attachmentId })

    await processAttachment(this.pool, attachmentId, async (attachment): Promise<ExtractionData | null> => {
      log.info({ filename: attachment.filename, mimeType: attachment.mimeType }, "Processing Excel workbook")

      try {
        const fileBuffer = await this.storage.getObject(attachment.storagePath)

        const format = validateExcelFormat(fileBuffer)
        log.info({ format }, "Excel format detected")

        const extracted = extractExcel(fileBuffer, format)

        const totalRows = extracted.sheets.reduce((sum, s) => sum + s.rows, 0)
        const totalCells = extracted.sheets.reduce((sum, s) => sum + s.rows * s.columns, 0)

        const sizeTier = determineSizeTier(totalCells)
        const injectionStrategy = determineInjectionStrategy(sizeTier)

        const sheetInfos: ExcelSheetInfo[] = extracted.sheets.map((s) => ({
          name: s.name,
          rows: s.rows,
          columns: s.columns,
          headers: s.headers,
          columnTypes: s.columnTypes,
          sampleRows: s.sampleRows,
        }))

        const chartInfos: ExcelChartInfo[] = extracted.charts.map((c) => ({
          sheetName: c.sheetName,
          type: c.type,
          title: c.title,
          description: c.description,
        }))

        const excelMetadata: ExcelMetadata = {
          format,
          sizeTier,
          injectionStrategy,
          totalSheets: extracted.sheets.length,
          totalRows,
          totalCells,
          author: extracted.metadata.author,
          createdAt: extracted.metadata.createdAt?.toISOString() ?? null,
          modifiedAt: extracted.metadata.modifiedAt?.toISOString() ?? null,
          sheets: sheetInfos,
          charts: chartInfos,
        }

        let summary: string
        let fullTextToStore: string | null

        if (sizeTier === TextSizeTiers.LARGE) {
          fullTextToStore = null

          const sheetOverview = buildSheetOverview(extracted.sheets)
          const sampleData = buildSampleDataPreview(extracted.sheets)

          const summaryResult = await this.ai.generateObject({
            model: EXCEL_SUMMARY_MODEL_ID,
            schema: excelSummarySchema,
            temperature: EXCEL_SUMMARY_TEMPERATURE,
            messages: [
              { role: "system", content: EXCEL_SUMMARY_SYSTEM_PROMPT },
              {
                role: "user",
                content: EXCEL_SUMMARY_USER_PROMPT.replace("{filename}", attachment.filename)
                  .replace("{sheetCount}", String(extracted.sheets.length))
                  .replace("{totalRows}", String(totalRows))
                  .replace("{totalCells}", String(totalCells))
                  .replace("{sheetOverview}", sheetOverview)
                  .replace("{sampleData}", sampleData),
              },
            ],
            telemetry: {
              functionId: "excel-summary",
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
          log.info({ format, sizeTier, summaryLength: summary.length }, "Excel summary generated")
        } else {
          fullTextToStore = buildFullMarkdown(extracted.sheets, sizeTier)
          summary = generateSimpleSummary(attachment.filename, format, extracted.sheets.length, totalRows, totalCells)
        }

        return {
          contentType: "document" as const,
          summary,
          fullText: fullTextToStore,
          structuredData: null,
          sourceType: "excel" as const,
          excelMetadata,
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        if (errorMessage.includes("password") || errorMessage.includes("encrypted")) {
          log.info({ filename: attachment.filename }, "Password-protected workbook, marking as skipped")
          return null
        }

        log.error({ error }, "Excel processing failed")
        throw error
      }
    })
  }
}

function determineSizeTier(totalCells: number): TextSizeTier {
  if (totalCells <= EXCEL_SIZE_THRESHOLDS.smallCells) {
    return TextSizeTiers.SMALL
  }
  if (totalCells <= EXCEL_SIZE_THRESHOLDS.mediumCells) {
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

function buildSheetOverview(sheets: ExtractedSheet[]): string {
  return sheets
    .map((s) => {
      const headerStr = s.headers.length > 0 ? ` | Headers: ${s.headers.join(", ")}` : ""
      return `- "${s.name}": ${s.rows} rows x ${s.columns} cols${headerStr}`
    })
    .join("\n")
}

function buildSampleDataPreview(sheets: ExtractedSheet[]): string {
  return sheets
    .filter((s) => s.sampleRows.length > 0)
    .slice(0, 3)
    .map((s) => {
      const headerRow = `| ${s.headers.join(" | ")} |`
      const separator = `| ${s.headers.map(() => "---").join(" | ")} |`
      const dataRows = s.sampleRows.map((row) => `| ${row.join(" | ")} |`).join("\n")
      return `Sheet "${s.name}":\n${headerRow}\n${separator}\n${dataRows}`
    })
    .join("\n\n")
}

/**
 * For medium workbooks, sheets >100 rows are sampled rather than included in full.
 */
function buildFullMarkdown(sheets: ExtractedSheet[], sizeTier: TextSizeTier): string {
  const parts: string[] = []

  for (const sheet of sheets) {
    parts.push(`## Sheet: ${sheet.name}`)
    parts.push(`${sheet.rows} rows x ${sheet.columns} columns`)

    if (sheet.headers.length === 0) {
      parts.push("(empty sheet)")
      parts.push("")
      continue
    }

    const shouldSample = sizeTier === TextSizeTiers.MEDIUM && sheet.rows > EXCEL_SHEET_THRESHOLDS.alwaysFullRows

    const headerRow = `| ${sheet.headers.join(" | ")} |`
    const separator = `| ${sheet.headers.map(() => "---").join(" | ")} |`

    if (shouldSample || sheet.rows > EXCEL_SHEET_THRESHOLDS.alwaysSampleRows) {
      const sampleRows = sheet.sampleRows.map((row) => `| ${row.join(" | ")} |`).join("\n")
      parts.push(headerRow)
      parts.push(separator)
      parts.push(sampleRows)
      parts.push(`\n... (${sheet.rows - sheet.sampleRows.length} more rows)`)
    } else {
      const allRows = sheet.data.map((row) => `| ${row.join(" | ")} |`).join("\n")
      parts.push(headerRow)
      parts.push(separator)
      parts.push(allRows)
    }

    parts.push("")
  }

  return parts.join("\n")
}

function generateSimpleSummary(
  filename: string,
  format: ExcelFormat,
  sheetCount: number,
  totalRows: number,
  totalCells: number
): string {
  const formatDesc = format === "xlsx" ? "Excel workbook" : "Legacy Excel workbook"
  return `${formatDesc} "${filename}" with ${sheetCount} sheet${sheetCount > 1 ? "s" : ""} (${totalRows} rows, ${totalCells} cells).`
}
