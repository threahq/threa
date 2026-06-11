import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME } from "@threa/types"
import { logger } from "../../../lib/logger"
import { AttachmentRepository, AttachmentExtractionRepository, EXCEL_MAX_ROWS_PER_REQUEST } from "../../attachments"
import { defineAgentTool, type AgentToolResult } from "../runtime"
import type { WorkspaceToolDeps } from "./tool-deps"

const LoadExcelSectionSchema = z
  .object({
    attachmentId: z.string().describe("The ID of the Excel attachment"),
    sheetName: z.string().describe("The name of the sheet to load data from"),
    startRow: z.number().int().min(0).optional().describe("Start row (0-indexed, inclusive). Defaults to 0."),
    endRow: z.number().int().min(0).optional().describe("End row (0-indexed, exclusive). Defaults to end of sheet."),
  })
  .refine(
    (data) => {
      if (data.startRow !== undefined && data.endRow !== undefined) {
        return data.startRow < data.endRow
      }
      return true
    },
    {
      message: "startRow must be less than endRow",
      path: ["startRow"],
    }
  )
  .refine(
    (data) => {
      if (data.startRow !== undefined && data.endRow !== undefined) {
        return data.endRow - data.startRow <= EXCEL_MAX_ROWS_PER_REQUEST
      }
      return true
    },
    {
      // Lazy callback: evaluated at parse time, not schema-construction time.
      // Reading EXCEL_MAX_ROWS_PER_REQUEST at module init races a circular
      // import through the attachments barrel and throws a TDZ ReferenceError
      // depending on module load order.
      error: () => `Cannot load more than ${EXCEL_MAX_ROWS_PER_REQUEST} rows at once`,
      path: ["endRow"],
    }
  )

export type LoadExcelSectionInput = z.infer<typeof LoadExcelSectionSchema>

export interface LoadExcelSectionResult {
  attachmentId: string
  filename: string
  sheetName: string
  startRow: number
  endRow: number
  totalRows: number
  headers: string[]
  content: string
}

export function createLoadExcelSectionTool(deps: WorkspaceToolDeps) {
  const { db, accessibleStreamIds, storage } = deps

  return defineAgentTool({
    name: "load_excel_section",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.LOAD_EXCEL_SECTION],
    description: `Load specific rows from a sheet in a large Excel workbook. Only use this when:
- The workbook is large (>20K cells) and injection strategy is "summary" (full content not in context)
- You need to read specific rows from a particular sheet
- The user asks about data in a specific sheet or row range

The attachment extraction includes excelMetadata.sheets with sheet names, row counts, headers, and sample rows. Use that to determine which sheet and rows to load.

For small/medium workbooks (<20K cells), full content is already available in fullText - don't use this tool.`,
    inputSchema: LoadExcelSectionSchema,

    execute: async (input): Promise<AgentToolResult> => {
      try {
        const attachment = await AttachmentRepository.findById(db, input.attachmentId)
        if (!attachment) {
          return {
            output: JSON.stringify({
              error: "Excel file not found, not accessible, or sheet/rows not available",
              attachmentId: input.attachmentId,
              sheetName: input.sheetName,
            }),
          }
        }
        if (!attachment.streamId || !accessibleStreamIds.includes(attachment.streamId)) {
          return {
            output: JSON.stringify({
              error: "Excel file not found, not accessible, or sheet/rows not available",
              attachmentId: input.attachmentId,
              sheetName: input.sheetName,
            }),
          }
        }

        const extraction = await AttachmentExtractionRepository.findByAttachmentId(db, input.attachmentId)
        if (!extraction || extraction.sourceType !== "excel" || !extraction.excelMetadata) {
          return {
            output: JSON.stringify({
              error: "Excel file not found, not accessible, or sheet/rows not available",
              attachmentId: input.attachmentId,
              sheetName: input.sheetName,
            }),
          }
        }

        const sheetInfo = extraction.excelMetadata.sheets.find((s) => s.name === input.sheetName)
        if (!sheetInfo) {
          return {
            output: JSON.stringify({
              error: "Excel file not found, not accessible, or sheet/rows not available",
              attachmentId: input.attachmentId,
              sheetName: input.sheetName,
            }),
          }
        }

        const startRow = input.startRow ?? 0
        const endRow = Math.min(input.endRow ?? sheetInfo.rows, startRow + EXCEL_MAX_ROWS_PER_REQUEST)
        if (startRow >= sheetInfo.rows || endRow > sheetInfo.rows) {
          return {
            output: JSON.stringify({
              error: "Excel file not found, not accessible, or sheet/rows not available",
              attachmentId: input.attachmentId,
              sheetName: input.sheetName,
            }),
          }
        }

        const { extractExcel } = await import("../../attachments/excel/extractor")
        const { validateExcelFormat } = await import("../../attachments/excel/detector")
        const fileBuffer = await storage.getObject(attachment.storagePath)
        const format = validateExcelFormat(fileBuffer)
        const extracted = extractExcel(fileBuffer, format)

        const sheet = extracted.sheets.find((s) => s.name === input.sheetName)
        if (!sheet) {
          return {
            output: JSON.stringify({
              error: "Excel file not found, not accessible, or sheet/rows not available",
              attachmentId: input.attachmentId,
              sheetName: input.sheetName,
            }),
          }
        }

        const selectedRows = sheet.data.slice(startRow, endRow)
        const headerRow = `| ${sheet.headers.join(" | ")} |`
        const separator = `| ${sheet.headers.map(() => "---").join(" | ")} |`
        const dataRows = selectedRows.map((row) => `| ${row.join(" | ")} |`).join("\n")

        const result: LoadExcelSectionResult = {
          attachmentId: input.attachmentId,
          filename: attachment.filename,
          sheetName: input.sheetName,
          startRow,
          endRow,
          totalRows: sheet.rows,
          headers: sheet.headers,
          content: `${headerRow}\n${separator}\n${dataRows}`,
        }

        logger.debug(
          {
            attachmentId: input.attachmentId,
            sheetName: input.sheetName,
            startRow: result.startRow,
            endRow: result.endRow,
            contentLength: result.content.length,
          },
          "Excel section loaded"
        )

        return {
          output: JSON.stringify({
            filename: result.filename,
            sheetName: result.sheetName,
            rowRange: `${result.startRow}-${result.endRow - 1} of ${result.totalRows}`,
            headers: result.headers,
            content: result.content,
          }),
        }
      } catch (error) {
        logger.error({ error, ...input }, "Load Excel section failed")
        return {
          output: JSON.stringify({
            error: `Failed to load Excel section: ${error instanceof Error ? error.message : "Unknown error"}`,
            attachmentId: input.attachmentId,
          }),
        }
      }
    },

    trace: {
      stepType: AgentStepTypes.TOOL_CALL,
      formatContent: (input) =>
        JSON.stringify({ tool: "load_excel_section", attachmentId: input.attachmentId, sheet: input.sheetName }),
    },
  })
}
