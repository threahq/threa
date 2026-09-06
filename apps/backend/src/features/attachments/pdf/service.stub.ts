import type { Pool } from "pg"
import { withClient, withTransaction } from "../../../db"
import { pdfPageId, pdfJobId, extractionId } from "../../../lib/id"
import { AttachmentRepository } from "../repository"
import { AttachmentExtractionRepository } from "../extraction-repository"
import { PdfPageExtractionRepository } from "./page-extraction-repository"
import { PdfProcessingJobRepository } from "./job-repository"
import {
  ProcessingStatuses,
  PdfJobStatuses,
  PdfPageClassifications,
  PdfSizeTiers,
  type PdfSizeTier,
} from "@threahq/types"
import { logger } from "../../../lib/logger"
import { PDF_SIZE_THRESHOLDS } from "./config"
import type { PdfProcessingServiceLike } from "./types"
import { OutboxRepository } from "../../../lib/outbox"

export interface StubPdfProcessingServiceDeps {
  pool: Pool
}

export class StubPdfProcessingService implements PdfProcessingServiceLike {
  private readonly pool: Pool

  constructor(deps: StubPdfProcessingServiceDeps) {
    this.pool = deps.pool
  }

  async prepare(attachmentId: string): Promise<void> {
    const log = logger.child({ attachmentId, phase: "prepare", stub: true })

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

    const totalPages = 5
    const jobId = pdfJobId()

    await withTransaction(this.pool, async (client) => {
      await PdfProcessingJobRepository.insert(client, {
        id: jobId,
        attachmentId,
        workspaceId: attachment.workspaceId,
        totalPages,
        status: PdfJobStatuses.PREPARING,
      })

      for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        await PdfPageExtractionRepository.insert(client, {
          id: pdfPageId(),
          attachmentId,
          workspaceId: attachment.workspaceId,
          pageNumber: pageNum,
          classification: PdfPageClassifications.TEXT_RICH,
          rawText: `[Stub] Page ${pageNum} content for ${attachment.filename}`,
          processingStatus: ProcessingStatuses.COMPLETED,
        })
      }

      await PdfProcessingJobRepository.updateStatus(client, jobId, PdfJobStatuses.PROCESSING_PAGES)

      for (let i = 0; i < totalPages; i++) {
        await PdfProcessingJobRepository.incrementPagesCompleted(client, jobId)
      }
    })

    // Go straight to assemble
    await this.assemble(attachmentId, jobId)
  }

  async processPage(_attachmentId: string, _pageNumber: number, _pdfJobId: string): Promise<void> {
    // Stub: No-op since prepare() already marks pages as completed
  }

  async assemble(attachmentId: string, pdfJobId: string): Promise<void> {
    const log = logger.child({ attachmentId, pdfJobId, phase: "assemble", stub: true })

    const { attachment, pages, job } = await withClient(this.pool, async (client) => {
      const att = await AttachmentRepository.findById(client, attachmentId)
      const pdfJob = await PdfProcessingJobRepository.findById(client, pdfJobId)
      const pageExtractions = await PdfPageExtractionRepository.findByAttachmentId(client, attachmentId)
      return { attachment: att, pages: pageExtractions, job: pdfJob }
    })

    if (!attachment || !job) {
      log.warn("Attachment or job not found")
      return
    }

    const fullText = pages.map((p) => p.rawText ?? "").join("\n\n---\n\n")
    let sizeTier: PdfSizeTier = PdfSizeTiers.LARGE
    if (pages.length < PDF_SIZE_THRESHOLDS.small) {
      sizeTier = PdfSizeTiers.SMALL
    } else if (pages.length <= PDF_SIZE_THRESHOLDS.medium) {
      sizeTier = PdfSizeTiers.MEDIUM
    }

    await withTransaction(this.pool, async (client) => {
      await AttachmentExtractionRepository.insert(client, {
        id: extractionId(),
        attachmentId,
        workspaceId: attachment.workspaceId,
        contentType: "document",
        summary: `[Stub] This is a ${pages.length}-page document titled "${attachment.filename}".`,
        fullText,
        structuredData: null,
        sourceType: "pdf",
        pdfMetadata: {
          totalPages: pages.length,
          sizeTier,
          sections: [{ startPage: 1, endPage: pages.length, title: "Main Content" }],
        },
      })

      await PdfProcessingJobRepository.updateStatus(client, pdfJobId, PdfJobStatuses.COMPLETED)
      await AttachmentRepository.updateProcessingStatus(client, attachmentId, ProcessingStatuses.COMPLETED)
      await OutboxRepository.insert(client, "attachment:extraction_completed", {
        workspaceId: attachment.workspaceId,
        attachmentId,
        contentType: "document",
      })
    })

    log.info({ pageCount: pages.length }, "Stub PDF processing complete")
  }
}
