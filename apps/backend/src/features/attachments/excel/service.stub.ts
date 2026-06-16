import type { Pool } from "pg"
import type { ExcelMetadata } from "@threa/types"
import { withClient, withTransaction } from "../../../db"
import { extractionId } from "../../../lib/id"
import { AttachmentRepository } from "../repository"
import { AttachmentExtractionRepository } from "../extraction-repository"
import { ProcessingStatuses, TextSizeTiers, InjectionStrategies } from "@threa/types"
import { logger } from "../../../lib/logger"
import type { ExcelProcessingServiceLike } from "./types"

export interface StubExcelProcessingServiceDeps {
  pool: Pool
}

export class StubExcelProcessingService implements ExcelProcessingServiceLike {
  private readonly pool: Pool

  constructor(deps: StubExcelProcessingServiceDeps) {
    this.pool = deps.pool
  }

  async processExcel(attachmentId: string): Promise<void> {
    const log = logger.child({ attachmentId, stub: true })

    const attachment = await withClient(this.pool, async (client) => {
      const att = await AttachmentRepository.findById(client, attachmentId)
      if (!att) return null

      await AttachmentRepository.updateProcessingStatus(client, attachmentId, ProcessingStatuses.PROCESSING)
      return att
    })

    if (!attachment) {
      log.warn("Attachment not found")
      return
    }

    const isXlsx =
      attachment.filename.toLowerCase().endsWith(".xlsx") || attachment.filename.toLowerCase().endsWith(".xlsm")
    const format = isXlsx ? "xlsx" : "xls"

    const excelMetadata: ExcelMetadata = {
      format,
      sizeTier: TextSizeTiers.SMALL,
      injectionStrategy: InjectionStrategies.FULL,
      totalSheets: 2,
      totalRows: 50,
      totalCells: 300,
      author: "Test Author",
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      sheets: [
        {
          name: "Sheet1",
          rows: 30,
          columns: 6,
          headers: ["A", "B", "C", "D", "E", "F"],
          columnTypes: ["integer", "text", "text", "number", "date", "text"],
          sampleRows: [
            ["1", "Item A", "Category 1", "100.50", "2024-01-15", "Active"],
            ["2", "Item B", "Category 2", "200.75", "2024-02-20", "Inactive"],
            ["3", "Item C", "Category 1", "150.25", "2024-03-10", "Active"],
          ],
        },
        {
          name: "Summary",
          rows: 20,
          columns: 3,
          headers: ["A", "B", "C"],
          columnTypes: ["text", "number", "integer"],
          sampleRows: [
            ["Category 1", "250.75", "2"],
            ["Category 2", "200.75", "1"],
          ],
        },
      ],
      charts: [],
    }

    await withTransaction(this.pool, async (client) => {
      await AttachmentExtractionRepository.insert(client, {
        id: extractionId(),
        attachmentId,
        workspaceId: attachment.workspaceId,
        contentType: "document",
        summary: `[Stub] Excel workbook "${attachment.filename}" with 2 sheets (50 rows, 300 cells).`,
        fullText: `[Stub] Content of ${attachment.filename}\n\n## Sheet: Sheet1\n30 rows x 6 columns\n\n## Sheet: Summary\n20 rows x 3 columns`,
        structuredData: null,
        sourceType: "excel",
        excelMetadata,
      })

      await AttachmentRepository.updateProcessingStatus(client, attachmentId, ProcessingStatuses.COMPLETED)
    })

    log.info({ filename: attachment.filename }, "Stub excel processing complete")
  }
}
