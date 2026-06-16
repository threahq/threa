import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME } from "@threa/types"
import { logger } from "../../../lib/logger"
import type { Pool } from "pg"
import {
  AttachmentExtractionRepository,
  PdfPageExtractionRepository,
  EXCEL_MAX_ROWS_PER_REQUEST,
  type Attachment,
} from "../../attachments"
import type { StorageProvider } from "../../../lib/storage/s3-client"
import { defineAgentTool, type AgentToolResult } from "../runtime"
import type { WorkspaceToolDeps } from "./tool-deps"

const MAX_LINES_PER_REQUEST = 500
const MAX_PAGES_PER_REQUEST = 10

const ReadAttachmentSchema = z
  .object({
    attachmentId: z.string().describe("The ID of the attachment to read"),
    section: z
      .discriminatedUnion("kind", [
        z.object({
          kind: z.literal("lines"),
          startLine: z.number().int().min(0).describe("Start line (0-indexed, inclusive)"),
          endLine: z.number().int().min(0).describe("End line (0-indexed, exclusive)"),
        }),
        z.object({
          kind: z.literal("pages"),
          startPage: z.number().int().min(1).describe("Start page (1-indexed, inclusive)"),
          endPage: z.number().int().min(1).describe("End page (1-indexed, inclusive)"),
        }),
        z.object({
          kind: z.literal("rows"),
          sheetName: z.string().describe("Name of the sheet to read"),
          startRow: z.number().int().min(0).optional().describe("Start row (0-indexed, inclusive). Defaults to 0."),
          endRow: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("End row (0-indexed, exclusive). Defaults to end of sheet."),
        }),
      ])
      .optional()
      .describe(
        "Omit to read the whole attachment: extracted text, structured data, and metadata, plus the image itself for pictures/diagrams. Provide a section ONLY to page through a file too large to return in full — the metadata in the default read lists the available lines, pages, and sheets."
      ),
  })
  // Static range guardrails (the dynamic bound — against the file's actual
  // length — is checked in execute once the extraction is known). Lives on the
  // outer object because z.discriminatedUnion forbids `.refine` on its members.
  .superRefine((value, ctx) => {
    const section = value.section
    if (!section) return
    if (section.kind === "lines") {
      if (section.startLine >= section.endLine) {
        ctx.addIssue({ code: "custom", path: ["section", "startLine"], message: "startLine must be less than endLine" })
      } else if (section.endLine - section.startLine > MAX_LINES_PER_REQUEST) {
        ctx.addIssue({
          code: "custom",
          path: ["section", "endLine"],
          message: `Cannot read more than ${MAX_LINES_PER_REQUEST} lines at once`,
        })
      }
    } else if (section.kind === "pages") {
      if (section.startPage > section.endPage) {
        ctx.addIssue({
          code: "custom",
          path: ["section", "startPage"],
          message: "startPage must be less than or equal to endPage",
        })
      } else if (section.endPage - section.startPage + 1 > MAX_PAGES_PER_REQUEST) {
        ctx.addIssue({
          code: "custom",
          path: ["section", "endPage"],
          message: `Cannot read more than ${MAX_PAGES_PER_REQUEST} pages at once`,
        })
      }
    } else if (section.startRow !== undefined && section.endRow !== undefined) {
      if (section.startRow >= section.endRow) {
        ctx.addIssue({ code: "custom", path: ["section", "startRow"], message: "startRow must be less than endRow" })
      } else if (section.endRow - section.startRow > EXCEL_MAX_ROWS_PER_REQUEST) {
        ctx.addIssue({
          code: "custom",
          path: ["section", "endRow"],
          message: `Cannot read more than ${EXCEL_MAX_ROWS_PER_REQUEST} rows at once`,
        })
      }
    }
  })

export type ReadAttachmentInput = z.infer<typeof ReadAttachmentSchema>

function errorOutput(error: string, attachmentId: string): AgentToolResult {
  return { output: JSON.stringify({ error, attachmentId }) }
}

async function readWhole(
  db: Pool,
  storage: StorageProvider,
  attachment: Attachment,
  supportsVision: boolean
): Promise<AgentToolResult> {
  const extraction = await AttachmentExtractionRepository.findByAttachmentId(db, attachment.id)
  const output = JSON.stringify({
    id: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    processingStatus: attachment.processingStatus,
    extraction: extraction
      ? {
          contentType: extraction.contentType,
          summary: extraction.summary,
          fullText: extraction.fullText,
          structuredData: extraction.structuredData,
          textMetadata: extraction.textMetadata,
          pdfMetadata: extraction.pdfMetadata,
          excelMetadata: extraction.excelMetadata,
        }
      : null,
  })

  // For a visual file on a vision-capable model, attach the bytes so the model
  // can SEE the image, not just read its caption. Non-vision models still get
  // the extraction text above — the read never hard-fails on missing vision.
  if (attachment.mimeType.startsWith("image/") && supportsVision) {
    const buffer = await storage.getObject(attachment.storagePath)
    const dataUrl = `data:${attachment.mimeType};base64,${buffer.toString("base64")}`
    return { output, multimodal: [{ type: "image", url: dataUrl }] }
  }
  return { output }
}

async function readLines(
  db: Pool,
  storage: StorageProvider,
  attachment: Attachment,
  startLine: number,
  endLine: number
): Promise<AgentToolResult> {
  const extraction = await AttachmentExtractionRepository.findByAttachmentId(db, attachment.id)
  if (!extraction || extraction.sourceType !== "text" || !extraction.textMetadata) {
    return errorOutput("This attachment has no readable text lines", attachment.id)
  }
  const totalLines = extraction.textMetadata.totalLines
  if (startLine >= totalLines || endLine > totalLines) {
    return errorOutput(`Requested lines are out of range; the file has ${totalLines} lines`, attachment.id)
  }
  const lines = (await storage.getObject(attachment.storagePath)).toString("utf-8").split("\n")
  return {
    output: JSON.stringify({
      filename: attachment.filename,
      lineRange: `${startLine}-${endLine - 1} of ${totalLines}`,
      content: lines.slice(startLine, endLine).join("\n"),
    }),
  }
}

async function readPages(
  db: Pool,
  attachment: Attachment,
  startPage: number,
  endPage: number
): Promise<AgentToolResult> {
  const extraction = await AttachmentExtractionRepository.findByAttachmentId(db, attachment.id)
  if (!extraction || extraction.sourceType !== "pdf" || !extraction.pdfMetadata) {
    return errorOutput("This attachment has no readable PDF pages", attachment.id)
  }
  const totalPages = extraction.pdfMetadata.totalPages
  if (startPage > totalPages || endPage > totalPages) {
    return errorOutput(`Requested pages are out of range; the PDF has ${totalPages} pages`, attachment.id)
  }
  const pages = await PdfPageExtractionRepository.findByAttachmentAndPageRange(db, attachment.id, startPage, endPage)
  return {
    output: JSON.stringify({
      filename: attachment.filename,
      pageRange: `${startPage}-${endPage} of ${totalPages}`,
      content: pages.map((p) => p.markdownContent ?? p.ocrText ?? p.rawText ?? "").join("\n\n---\n\n"),
    }),
  }
}

async function readRows(
  db: Pool,
  storage: StorageProvider,
  attachment: Attachment,
  sheetName: string,
  startRow: number | undefined,
  endRow: number | undefined
): Promise<AgentToolResult> {
  const extraction = await AttachmentExtractionRepository.findByAttachmentId(db, attachment.id)
  if (!extraction || extraction.sourceType !== "excel" || !extraction.excelMetadata) {
    return errorOutput("This attachment has no readable spreadsheet", attachment.id)
  }
  const sheetInfo = extraction.excelMetadata.sheets.find((s) => s.name === sheetName)
  if (!sheetInfo) {
    return errorOutput(`Sheet "${sheetName}" not found in this workbook`, attachment.id)
  }
  const start = startRow ?? 0
  const end = Math.min(endRow ?? sheetInfo.rows, start + EXCEL_MAX_ROWS_PER_REQUEST)
  if (start >= sheetInfo.rows || end > sheetInfo.rows) {
    return errorOutput(`Requested rows are out of range; the sheet has ${sheetInfo.rows} rows`, attachment.id)
  }

  const { extractExcel } = await import("../../attachments/excel/extractor")
  const { validateExcelFormat } = await import("../../attachments/excel/detector")
  const fileBuffer = await storage.getObject(attachment.storagePath)
  const extracted = extractExcel(fileBuffer, validateExcelFormat(fileBuffer))
  const sheet = extracted.sheets.find((s) => s.name === sheetName)
  if (!sheet) {
    return errorOutput(`Sheet "${sheetName}" not found in this workbook`, attachment.id)
  }

  const headerRow = `| ${sheet.headers.join(" | ")} |`
  const separator = `| ${sheet.headers.map(() => "---").join(" | ")} |`
  const dataRows = sheet.data
    .slice(start, end)
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n")
  return {
    output: JSON.stringify({
      filename: attachment.filename,
      sheetName,
      rowRange: `${start}-${end - 1} of ${sheet.rows}`,
      headers: sheet.headers,
      content: `${headerRow}\n${separator}\n${dataRows}`,
    }),
  }
}

/**
 * The one attachment-reading tool: a single verb the model can't pick wrong,
 * dispatched by intent (whole file vs. a section) and file type — image vision,
 * document text/data, or paged text/PDF/spreadsheet.
 *
 * Access is enforced once through `attachmentService.getAccessible` on every
 * path, section reads included, so `attachment_references` resends and the
 * sharing-safety status gate paged reads too, not just raw stream membership.
 */
export function createReadAttachmentTool(deps: WorkspaceToolDeps, options: { supportsVision: boolean }) {
  const { db, workspaceId, accessibleStreamIds, attachmentService, storage } = deps
  const { supportsVision } = options

  return defineAgentTool({
    name: "read_attachment",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.READ_ATTACHMENT],
    promptBlock: `## Reading Attachments

You have a \`read_attachment\` tool to read any file attached in the workspace — images, PDFs, text, code, spreadsheets.

- Call it with just an \`attachmentId\` to read the whole file: extracted text and structured data, plus the image itself for pictures and diagrams.
- If a file is too large to return in full, the response carries its metadata (line count, page count, or sheet names). Call again with a \`section\` to page through it by lines (text), pages (PDF), or rows (spreadsheet).

Use \`search_attachments\` first when you don't already have the attachment id.`,
    description: `Read a workspace attachment by id. Returns extracted text and structured data for documents, the image itself for pictures/diagrams, and metadata for everything. For a file too large to return whole, pass a \`section\` to page by lines (text), pages (PDF), or rows (spreadsheet).`,
    inputSchema: ReadAttachmentSchema,

    execute: async (input): Promise<AgentToolResult> => {
      try {
        const attachment = await attachmentService.getAccessible(input.attachmentId, {
          workspaceId,
          accessibleStreamIds,
        })
        if (!attachment) {
          return errorOutput("Attachment not found or not accessible", input.attachmentId)
        }

        const section = input.section
        if (!section) {
          return readWhole(db, storage, attachment, supportsVision)
        }
        if (section.kind === "lines") {
          return readLines(db, storage, attachment, section.startLine, section.endLine)
        }
        if (section.kind === "pages") {
          return readPages(db, attachment, section.startPage, section.endPage)
        }
        return readRows(db, storage, attachment, section.sheetName, section.startRow, section.endRow)
      } catch (error) {
        logger.error({ error, attachmentId: input.attachmentId }, "Read attachment failed")
        return errorOutput(
          `Failed to read attachment: ${error instanceof Error ? error.message : "Unknown error"}`,
          input.attachmentId
        )
      }
    },

    trace: {
      stepType: AgentStepTypes.TOOL_CALL,
      formatContent: (input, result) => {
        if (result.multimodal && result.multimodal.length > 0) {
          return `Read image: ${input.attachmentId}`
        }
        return JSON.stringify({
          tool: "read_attachment",
          attachmentId: input.attachmentId,
          section: input.section?.kind ?? "full",
        })
      },
    },
  })
}
