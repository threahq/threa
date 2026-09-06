/**
 * Fan-out/fan-in PDF pipeline: prepare() classifies and fans out page jobs,
 * processPage() handles each page, assemble() fans in. Each phase follows the
 * three-phase pattern (INV-41) so no DB connection is held during AI/OCR work.
 */

import type { Pool } from "pg"
import { getDocumentProxy } from "unpdf"
import { createWorker, type Worker as TesseractWorker } from "tesseract.js"
import { withClient, withTransaction } from "../../../db"
import { pdfPageId, pdfJobId, extractionId, attachmentId as genAttachmentId } from "../../../lib/id"
import { AttachmentRepository } from "../repository"
import { AttachmentExtractionRepository } from "../extraction-repository"
import { PdfPageExtractionRepository } from "./page-extraction-repository"
import { PdfProcessingJobRepository } from "./job-repository"
import type { StorageProvider } from "../../../lib/storage/s3-client"
import type { AI } from "@threahq/agent-runtime"
import type { QueueManager } from "../../../lib/queue"
import { ProcessingStatuses, PdfJobStatuses, PdfPageClassifications, PdfSizeTiers } from "@threahq/types"
import type { PdfPageClassification, PdfSizeTier } from "@threahq/types"
import { JobQueues } from "../../../lib/queue"
import { OutboxRepository } from "../../../lib/outbox"
import { logger } from "../../../lib/logger"
import { classifyPage, type ClassificationInput, type TextItemWithPosition } from "./classifier"
import {
  PDF_SIZE_THRESHOLDS,
  PDF_LAYOUT_MODEL_ID,
  PDF_SUMMARY_MODEL_ID,
  PDF_TEMPERATURES,
  PDF_LAYOUT_SYSTEM_PROMPT,
  PDF_LAYOUT_USER_PROMPT,
  PDF_SUMMARY_SYSTEM_PROMPT,
  PDF_SUMMARY_USER_PROMPT,
  layoutExtractionSchema,
  documentSummarySchema,
} from "./config"
import type { PdfProcessingServiceDeps, PdfProcessingServiceLike } from "./types"

export class PdfProcessingService implements PdfProcessingServiceLike {
  private readonly pool: Pool
  private readonly ai: AI
  private readonly storage: StorageProvider
  private readonly jobQueue: QueueManager

  constructor(deps: PdfProcessingServiceDeps) {
    this.pool = deps.pool
    this.ai = deps.ai
    this.storage = deps.storage
    this.jobQueue = deps.jobQueue
  }

  async prepare(attachmentId: string): Promise<void> {
    const log = logger.child({ attachmentId, phase: "prepare" })

    // Claim the attachment for processing.
    const attachment = await withClient(this.pool, async (client) => {
      const att = await AttachmentRepository.findById(client, attachmentId)
      if (!att) {
        log.warn("Attachment not found, skipping")
        return null
      }

      const claimed = await AttachmentRepository.updateProcessingStatus(
        client,
        attachmentId,
        ProcessingStatuses.PROCESSING,
        { onlyIfStatusIn: [ProcessingStatuses.PENDING, ProcessingStatuses.PROCESSING, ProcessingStatuses.FAILED] }
      )

      if (!claimed) {
        log.info({ currentStatus: att.processingStatus }, "Attachment already completed/skipped")
        return null
      }

      return att
    })

    if (!attachment) {
      return
    }

    log.info({ filename: attachment.filename }, "Starting PDF preparation")

    // Download and analyze the PDF with no DB connection held (INV-41).
    let pdfData: Uint8Array
    let pageInfos: Array<{
      pageNumber: number
      classification: PdfPageClassification
      rawText: string | null
      imageCount: number
    }>

    try {
      const pdfBuffer = await this.storage.getObject(attachment.storagePath)
      pdfData = new Uint8Array(pdfBuffer)

      const pdf = await getDocumentProxy(pdfData)
      const totalPages = pdf.numPages

      log.info({ totalPages }, "PDF loaded, extracting pages")

      pageInfos = []
      for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        const page = await pdf.getPage(pageNum)

        const textContent = await page.getTextContent()
        const textItems: TextItemWithPosition[] = []
        const textStrings: string[] = []

        for (const item of textContent.items) {
          if ("str" in item && "transform" in item) {
            const textItem = item as { str: string; transform: number[]; width: number; height: number }
            if (textItem.str.length > 0) {
              textStrings.push(textItem.str)
              // transform is [scaleX, skewX, skewY, scaleY, translateX, translateY]
              // translateX (index 4) is x position, translateY (index 5) is y position
              textItems.push({
                str: textItem.str,
                x: textItem.transform[4],
                y: textItem.transform[5],
                width: textItem.width ?? 0,
                height: textItem.height ?? 0,
              })
            }
          }
        }

        const rawText = textStrings.join(" ")

        const operators = await page.getOperatorList()
        const imageCount = operators.fnArray.filter((fn: number) => fn === 82 || fn === 83).length // paintImageXObject ops

        const classificationInput: ClassificationInput = {
          rawText,
          imageCount,
          textItems,
        }
        const { classification } = classifyPage(classificationInput)

        pageInfos.push({
          pageNumber: pageNum,
          classification,
          rawText: rawText.length > 0 ? rawText : null,
          imageCount,
        })
      }

      log.info({ pageCount: pageInfos.length }, "Pages extracted and classified")
    } catch (error) {
      log.error({ error }, "PDF extraction failed")
      throw error
    }

    const totalPages = pageInfos.length
    const jobId = pdfJobId()
    const sizeTier = this.determineSizeTier(totalPages)

    await withTransaction(this.pool, async (client) => {
      await PdfProcessingJobRepository.insert(client, {
        id: jobId,
        attachmentId,
        workspaceId: attachment.workspaceId,
        totalPages,
        status: PdfJobStatuses.PREPARING,
      })

      const pageRecords = pageInfos.map((info) => ({
        id: pdfPageId(),
        attachmentId,
        workspaceId: attachment.workspaceId,
        pageNumber: info.pageNumber,
        classification: info.classification,
        rawText: info.rawText,
        processingStatus: ProcessingStatuses.PENDING,
      }))

      for (const record of pageRecords) {
        await PdfPageExtractionRepository.insert(client, record)
      }

      await PdfProcessingJobRepository.updateStatus(client, jobId, PdfJobStatuses.PROCESSING_PAGES)
    })

    const pagesNeedingProcessing = pageInfos.filter(
      (p) => p.classification !== PdfPageClassifications.TEXT_RICH && p.classification !== PdfPageClassifications.EMPTY
    )
    const pagesAlreadyComplete = totalPages - pagesNeedingProcessing.length

    // Pre-increment pages_completed for text_rich/empty pages since they don't need processing.
    // This ensures the fan-in coordination check (pages_completed + pages_failed >= total_pages)
    // works correctly for PDFs with mixed page types.
    if (pagesAlreadyComplete > 0) {
      await withTransaction(this.pool, async (client) => {
        for (let i = 0; i < pagesAlreadyComplete; i++) {
          await PdfProcessingJobRepository.incrementPagesCompleted(client, jobId)
        }
      })
    }

    // Fan out page jobs outside the transaction.
    for (const page of pagesNeedingProcessing) {
      await this.jobQueue.send(JobQueues.PDF_PROCESS_PAGE, {
        attachmentId,
        workspaceId: attachment.workspaceId,
        pageNumber: page.pageNumber,
        pdfJobId: jobId,
      })
    }

    if (pagesNeedingProcessing.length === 0) {
      await this.jobQueue.send(JobQueues.PDF_ASSEMBLE, {
        attachmentId,
        workspaceId: attachment.workspaceId,
        pdfJobId: jobId,
      })
    }

    log.info(
      { totalPages, sizeTier, pagesNeedingProcessing: pagesNeedingProcessing.length },
      "PDF preparation complete, jobs fanned out"
    )
  }

  /**
   * Process a single page. Handling depends on classification: text_rich/empty
   * are already done in prepare(); scanned runs Tesseract OCR; complex_layout
   * and mixed run Gemini extraction.
   */
  async processPage(attachmentId: string, pageNumber: number, pdfJobId: string): Promise<void> {
    const log = logger.child({ attachmentId, pageNumber, pdfJobId, phase: "processPage" })

    const { page, attachment } = await withClient(this.pool, async (client) => {
      const att = await AttachmentRepository.findById(client, attachmentId)
      if (!att) {
        log.warn("Attachment not found")
        return { page: null, attachment: null }
      }

      const pageRecord = await PdfPageExtractionRepository.findByAttachmentAndPage(client, attachmentId, pageNumber)
      if (!pageRecord) {
        log.warn("Page record not found")
        return { page: null, attachment: null }
      }

      const claimed = await PdfPageExtractionRepository.updateProcessingStatus(
        client,
        pageRecord.id,
        ProcessingStatuses.PROCESSING,
        { onlyIfStatusIn: [ProcessingStatuses.PENDING, ProcessingStatuses.PROCESSING, ProcessingStatuses.FAILED] }
      )

      if (!claimed) {
        log.info({ currentStatus: pageRecord.processingStatus }, "Page already processed")
        return { page: null, attachment: att }
      }

      return { page: pageRecord, attachment: att }
    })

    if (!page || !attachment) {
      // An already-claimed/missing page still counts toward the fan-in check.
      await this.checkAndTriggerAssemble(pdfJobId, attachmentId, attachment?.workspaceId ?? "")
      return
    }

    log.info({ classification: page.classification }, "Processing page")

    // Process with no DB connection held (INV-41).
    let processedContent: {
      ocrText?: string | null
      markdownContent?: string | null
    } = {}

    try {
      switch (page.classification) {
        case PdfPageClassifications.TEXT_RICH:
        case PdfPageClassifications.EMPTY:
          break

        case PdfPageClassifications.SCANNED:
          processedContent = await this.processScannedPage(attachment.storagePath, pageNumber)
          break

        case PdfPageClassifications.COMPLEX_LAYOUT:
          processedContent = await this.processComplexPage(attachment, pageNumber)
          break

        case PdfPageClassifications.MIXED:
          processedContent = await this.processMixedPage(attachment, pageNumber)
          break
      }
    } catch (error) {
      log.error({ error }, "Page processing failed")

      await withTransaction(this.pool, async (client) => {
        await PdfPageExtractionRepository.updateProcessingStatus(client, page.id, ProcessingStatuses.FAILED, {
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        await PdfProcessingJobRepository.incrementPagesFailed(client, pdfJobId)
      })

      await this.checkAndTriggerAssemble(pdfJobId, attachmentId, attachment.workspaceId)
      return
    }

    await withTransaction(this.pool, async (client) => {
      await PdfPageExtractionRepository.update(client, page.id, {
        ocrText: processedContent.ocrText,
        markdownContent: processedContent.markdownContent,
        processingStatus: ProcessingStatuses.COMPLETED,
      })

      await PdfProcessingJobRepository.incrementPagesCompleted(client, pdfJobId)
    })

    log.info("Page processing complete")

    await this.checkAndTriggerAssemble(pdfJobId, attachmentId, attachment.workspaceId)
  }

  async assemble(attachmentId: string, pdfJobId: string): Promise<void> {
    const log = logger.child({ attachmentId, pdfJobId, phase: "assemble" })

    const { attachment, pages, job } = await withClient(this.pool, async (client) => {
      const att = await AttachmentRepository.findById(client, attachmentId)
      const pdfJob = await PdfProcessingJobRepository.findById(client, pdfJobId)
      const pageExtractions = await PdfPageExtractionRepository.findByAttachmentId(client, attachmentId)

      // Claim the assembling status to fence out a concurrent assemble.
      if (pdfJob) {
        await PdfProcessingJobRepository.updateStatus(client, pdfJobId, PdfJobStatuses.ASSEMBLING, {
          onlyIfStatus: PdfJobStatuses.PROCESSING_PAGES,
        })
      }

      return { attachment: att, pages: pageExtractions, job: pdfJob }
    })

    if (!attachment || !job) {
      log.warn("Attachment or job not found")
      return
    }

    log.info({ pageCount: pages.length }, "Assembling document")

    // Generate the document summary with no DB connection held (INV-41).
    let summary: {
      title: string | null
      summary: string
      sections: Array<{ startPage: number; endPage: number; title: string }>
    }
    let fullText: string

    try {
      fullText = pages
        .map((p) => {
          const content = p.markdownContent ?? p.ocrText ?? p.rawText ?? ""
          return content.trim()
        })
        .filter((c) => c.length > 0)
        .join("\n\n---\n\n")

      const sizeTier = this.determineSizeTier(pages.length)

      if (sizeTier === PdfSizeTiers.SMALL) {
        summary = {
          title: this.extractTitleFromContent(fullText),
          summary: this.createSimpleSummary(fullText),
          sections: [],
        }
      } else {
        const summaryPrompt = PDF_SUMMARY_USER_PROMPT.replace("{totalPages}", String(pages.length)).replace(
          "{content}",
          fullText.slice(0, 50000) // Cap content sent for summarization.
        )

        const { value } = await this.ai.generateObject({
          model: PDF_SUMMARY_MODEL_ID,
          schema: documentSummarySchema,
          temperature: PDF_TEMPERATURES.summary,
          messages: [
            { role: "system", content: PDF_SUMMARY_SYSTEM_PROMPT },
            { role: "user", content: summaryPrompt },
          ],
          telemetry: {
            functionId: "pdf-summary",
            metadata: {
              attachment_id: attachmentId,
              workspace_id: attachment.workspaceId,
              page_count: pages.length,
              size_tier: sizeTier,
            },
          },
          context: { workspaceId: attachment.workspaceId },
        })

        summary = {
          title: value.title,
          summary: value.summary,
          sections: value.sections,
        }
      }

      log.info({ titleFound: !!summary.title, sectionCount: summary.sections.length }, "Summary generated")
    } catch (error) {
      log.error({ error }, "Summary generation failed")
      throw error
    }

    const sizeTier = this.determineSizeTier(pages.length)

    await withTransaction(this.pool, async (client) => {
      await AttachmentExtractionRepository.insert(client, {
        id: extractionId(),
        attachmentId,
        workspaceId: attachment.workspaceId,
        contentType: "document",
        summary: summary.summary,
        fullText: sizeTier === PdfSizeTiers.LARGE ? null : fullText, // Large docs keep summary only, not full text.
        structuredData: null,
        sourceType: "pdf",
        pdfMetadata: {
          totalPages: pages.length,
          sizeTier,
          sections: summary.sections,
        },
      })

      await PdfProcessingJobRepository.updateStatus(client, pdfJobId, PdfJobStatuses.COMPLETED)

      await AttachmentRepository.updateProcessingStatus(client, attachmentId, ProcessingStatuses.COMPLETED)

      // Emit the same extraction-completed event the shared `processAttachment`
      // path emits, so PDFs flow through `AttachmentEmbeddingHandler` for the
      // summary embedding (INV-7 — atomic with the extraction insert).
      await OutboxRepository.insert(client, "attachment:extraction_completed", {
        workspaceId: attachment.workspaceId,
        attachmentId,
        contentType: "document",
      })
    })

    log.info({ sizeTier, totalPages: pages.length }, "PDF processing complete")
  }

  private determineSizeTier(pageCount: number): PdfSizeTier {
    if (pageCount < PDF_SIZE_THRESHOLDS.small) {
      return PdfSizeTiers.SMALL
    }
    if (pageCount <= PDF_SIZE_THRESHOLDS.medium) {
      return PdfSizeTiers.MEDIUM
    }
    return PdfSizeTiers.LARGE
  }

  private async processScannedPage(storagePath: string, pageNumber: number): Promise<{ ocrText: string | null }> {
    const log = logger.child({ storagePath, pageNumber, method: "processScannedPage" })

    try {
      const pdfBuffer = await this.storage.getObject(storagePath)
      const pdfData = new Uint8Array(pdfBuffer)
      const pdf = await getDocumentProxy(pdfData)
      const page = await pdf.getPage(pageNumber)

      const viewport = page.getViewport({ scale: 2.0 }) // Higher scale for better OCR accuracy.
      const canvas = new OffscreenCanvas(viewport.width, viewport.height)
      const context = canvas.getContext("2d")!

      await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise

      const blob = await canvas.convertToBlob({ type: "image/png" })
      const arrayBuffer = await blob.arrayBuffer()

      // Tesseract accepts a Buffer as an ImageLike input.
      const worker = await createWorker("eng")
      const { data } = await worker.recognize(Buffer.from(arrayBuffer))
      await worker.terminate()

      log.info({ textLength: data.text.length }, "OCR complete")
      return { ocrText: data.text || null }
    } catch (error) {
      log.error({ error }, "OCR failed")
      return { ocrText: null }
    }
  }

  private async processComplexPage(
    attachment: { storagePath: string; workspaceId: string; id: string },
    pageNumber: number
  ): Promise<{ markdownContent: string | null }> {
    const log = logger.child({ attachmentId: attachment.id, pageNumber, method: "processComplexPage" })

    try {
      const pdfBuffer = await this.storage.getObject(attachment.storagePath)
      const pdfData = new Uint8Array(pdfBuffer)
      const pdf = await getDocumentProxy(pdfData)
      const page = await pdf.getPage(pageNumber)

      const viewport = page.getViewport({ scale: 2.0 })
      const canvas = new OffscreenCanvas(viewport.width, viewport.height)
      const context = canvas.getContext("2d")!

      await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise

      const blob = await canvas.convertToBlob({ type: "image/png" })
      const arrayBuffer = await blob.arrayBuffer()
      const base64 = Buffer.from(arrayBuffer).toString("base64")

      const { value } = await this.ai.generateObject({
        model: PDF_LAYOUT_MODEL_ID,
        schema: layoutExtractionSchema,
        temperature: PDF_TEMPERATURES.layout,
        messages: [
          { role: "system", content: PDF_LAYOUT_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: PDF_LAYOUT_USER_PROMPT },
              { type: "image", image: base64, mimeType: "image/png" },
            ],
          },
        ],
        telemetry: {
          functionId: "pdf-layout-extraction",
          metadata: {
            attachment_id: attachment.id,
            workspace_id: attachment.workspaceId,
            page_number: pageNumber,
          },
        },
        context: { workspaceId: attachment.workspaceId },
      })

      log.info({ markdownLength: value.markdown.length }, "Layout extraction complete")
      return { markdownContent: value.markdown }
    } catch (error) {
      log.error({ error }, "Layout extraction failed")
      return { markdownContent: null }
    }
  }

  private async processMixedPage(
    attachment: { storagePath: string; workspaceId: string; id: string },
    pageNumber: number
  ): Promise<{ markdownContent: string | null }> {
    // Mixed pages need both text and image handling, which the layout path covers.
    return this.processComplexPage(attachment, pageNumber)
  }

  private async checkAndTriggerAssemble(pdfJobId: string, attachmentId: string, workspaceId: string): Promise<void> {
    const allDone = await PdfProcessingJobRepository.isAllPagesProcessed(this.pool, pdfJobId)

    if (allDone) {
      await this.jobQueue.send(JobQueues.PDF_ASSEMBLE, {
        attachmentId,
        workspaceId,
        pdfJobId,
      })
    }
  }

  private extractTitleFromContent(content: string): string | null {
    const firstLine = content.split("\n")[0]?.trim()
    if (firstLine && firstLine.length < 100 && firstLine.length > 5) {
      return firstLine.replace(/^#\s*/, "")
    }
    return null
  }

  private createSimpleSummary(content: string): string {
    const words = content.split(/\s+/).slice(0, 50)
    return words.join(" ") + (words.length === 50 ? "..." : "")
  }
}
