/**
 * PDF Processing Service
 *
 * Orchestrates the fan-out/fan-in PDF processing pipeline.
 * Uses the three-phase pattern (INV-41) to avoid holding database
 * connections during slow operations.
 *
 * Pipeline:
 * 1. prepare() - Extract text/images, classify pages, fan out page jobs
 * 2. processPage() - Process single page based on classification
 * 3. assemble() - Combine page results, generate summary, create extraction
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
import type { AI } from "@threa/agent-runtime"
import type { QueueManager } from "../../../lib/queue"
import { ProcessingStatuses, PdfJobStatuses, PdfPageClassifications, PdfSizeTiers } from "@threa/types"
import type { PdfPageClassification, PdfSizeTier } from "@threa/types"
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

  /**
   * Phase 1: Prepare PDF for processing.
   *
   * - Download PDF from storage
   * - Extract text and images from each page
   * - Classify pages
   * - Create page records in database
   * - Fan out page processing jobs
   */
  async prepare(attachmentId: string): Promise<void> {
    const log = logger.child({ attachmentId, phase: "prepare" })

    // =========================================================================
    // Phase 1a: Fetch attachment and claim it
    // =========================================================================
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

    // =========================================================================
    // Phase 1b: Download and analyze PDF (NO database connection held)
    // =========================================================================
    let pdfData: Uint8Array
    let pageInfos: Array<{
      pageNumber: number
      classification: PdfPageClassification
      rawText: string | null
      imageCount: number
    }>

    try {
      // Download PDF from storage
      const pdfBuffer = await this.storage.getObject(attachment.storagePath)
      pdfData = new Uint8Array(pdfBuffer)

      // Parse PDF using unpdf
      const pdf = await getDocumentProxy(pdfData)
      const totalPages = pdf.numPages

      log.info({ totalPages }, "PDF loaded, extracting pages")

      // Extract and classify each page
      pageInfos = []
      for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        const page = await pdf.getPage(pageNum)

        // Extract text content with position info
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

        // Get page operators to detect images
        const operators = await page.getOperatorList()
        const imageCount = operators.fnArray.filter((fn: number) => fn === 82 || fn === 83).length // paintImageXObject ops

        // Classify the page with text position data for layout detection
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

    // =========================================================================
    // Phase 1c: Create job and page records, fan out page jobs
    // =========================================================================
    const totalPages = pageInfos.length
    const jobId = pdfJobId()
    const sizeTier = this.determineSizeTier(totalPages)

    await withTransaction(this.pool, async (client) => {
      // Create processing job
      await PdfProcessingJobRepository.insert(client, {
        id: jobId,
        attachmentId,
        workspaceId: attachment.workspaceId,
        totalPages,
        status: PdfJobStatuses.PREPARING,
      })

      // Create page extraction records
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

      // Update job status to processing_pages
      await PdfProcessingJobRepository.updateStatus(client, jobId, PdfJobStatuses.PROCESSING_PAGES)
    })

    // Determine which pages need processing vs are already complete
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

    // Fan out page processing jobs (outside transaction)
    for (const page of pagesNeedingProcessing) {
      await this.jobQueue.send(JobQueues.PDF_PROCESS_PAGE, {
        attachmentId,
        workspaceId: attachment.workspaceId,
        pageNumber: page.pageNumber,
        pdfJobId: jobId,
      })
    }

    // If no pages need additional processing, go straight to assemble
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
   * Phase 2: Process a single page.
   *
   * Processing depends on page classification:
   * - text_rich: Already extracted in prepare(), mark complete
   * - scanned: Apply Tesseract OCR
   * - complex_layout: Use Gemini for extraction
   * - mixed: Text extraction + image captioning
   * - empty: Mark complete immediately
   */
  async processPage(attachmentId: string, pageNumber: number, pdfJobId: string): Promise<void> {
    const log = logger.child({ attachmentId, pageNumber, pdfJobId, phase: "processPage" })

    // =========================================================================
    // Phase 2a: Fetch page record and claim it
    // =========================================================================
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

      // Claim the page
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
      // Still need to check if all pages are done
      await this.checkAndTriggerAssemble(pdfJobId, attachmentId, attachment?.workspaceId ?? "")
      return
    }

    log.info({ classification: page.classification }, "Processing page")

    // =========================================================================
    // Phase 2b: Process based on classification (NO database connection)
    // =========================================================================
    let processedContent: {
      ocrText?: string | null
      markdownContent?: string | null
    } = {}

    try {
      switch (page.classification) {
        case PdfPageClassifications.TEXT_RICH:
        case PdfPageClassifications.EMPTY:
          // Already have text or nothing to extract
          break

        case PdfPageClassifications.SCANNED:
          // Apply OCR
          processedContent = await this.processScannedPage(attachment.storagePath, pageNumber)
          break

        case PdfPageClassifications.COMPLEX_LAYOUT:
          // Use Gemini for extraction
          processedContent = await this.processComplexPage(attachment, pageNumber)
          break

        case PdfPageClassifications.MIXED:
          // Use both text and Gemini for images
          processedContent = await this.processMixedPage(attachment, pageNumber)
          break
      }
    } catch (error) {
      log.error({ error }, "Page processing failed")

      // Mark page as failed and increment failed count
      await withTransaction(this.pool, async (client) => {
        await PdfPageExtractionRepository.updateProcessingStatus(client, page.id, ProcessingStatuses.FAILED, {
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        await PdfProcessingJobRepository.incrementPagesFailed(client, pdfJobId)
      })

      await this.checkAndTriggerAssemble(pdfJobId, attachmentId, attachment.workspaceId)
      return
    }

    // =========================================================================
    // Phase 2c: Save results and update completion count
    // =========================================================================
    await withTransaction(this.pool, async (client) => {
      // Update page with processed content
      await PdfPageExtractionRepository.update(client, page.id, {
        ocrText: processedContent.ocrText,
        markdownContent: processedContent.markdownContent,
        processingStatus: ProcessingStatuses.COMPLETED,
      })

      // Increment completed count
      await PdfProcessingJobRepository.incrementPagesCompleted(client, pdfJobId)
    })

    log.info("Page processing complete")

    // Check if all pages are done and trigger assemble
    await this.checkAndTriggerAssemble(pdfJobId, attachmentId, attachment.workspaceId)
  }

  /**
   * Phase 3: Assemble final document extraction.
   *
   * - Combine all page content
   * - Generate document summary
   * - Create attachment extraction record
   * - Mark attachment as completed
   */
  async assemble(attachmentId: string, pdfJobId: string): Promise<void> {
    const log = logger.child({ attachmentId, pdfJobId, phase: "assemble" })

    // =========================================================================
    // Phase 3a: Fetch all page extractions
    // =========================================================================
    const { attachment, pages, job } = await withClient(this.pool, async (client) => {
      const att = await AttachmentRepository.findById(client, attachmentId)
      const pdfJob = await PdfProcessingJobRepository.findById(client, pdfJobId)
      const pageExtractions = await PdfPageExtractionRepository.findByAttachmentId(client, attachmentId)

      // Claim assembling status
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

    // =========================================================================
    // Phase 3b: Generate document summary (NO database connection)
    // =========================================================================
    let summary: {
      title: string | null
      summary: string
      sections: Array<{ startPage: number; endPage: number; title: string }>
    }
    let fullText: string

    try {
      // Combine all page content
      fullText = pages
        .map((p) => {
          const content = p.markdownContent ?? p.ocrText ?? p.rawText ?? ""
          return content.trim()
        })
        .filter((c) => c.length > 0)
        .join("\n\n---\n\n")

      // Generate summary for medium/large documents
      const sizeTier = this.determineSizeTier(pages.length)

      if (sizeTier === PdfSizeTiers.SMALL) {
        // Small documents don't need AI summary
        summary = {
          title: this.extractTitleFromContent(fullText),
          summary: this.createSimpleSummary(fullText),
          sections: [],
        }
      } else {
        // Use AI for larger documents
        const summaryPrompt = PDF_SUMMARY_USER_PROMPT.replace("{totalPages}", String(pages.length)).replace(
          "{content}",
          fullText.slice(0, 50000) // Limit content for summarization
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

    // =========================================================================
    // Phase 3c: Create extraction and mark complete
    // =========================================================================
    const sizeTier = this.determineSizeTier(pages.length)

    await withTransaction(this.pool, async (client) => {
      // Create document extraction
      await AttachmentExtractionRepository.insert(client, {
        id: extractionId(),
        attachmentId,
        workspaceId: attachment.workspaceId,
        contentType: "document",
        summary: summary.summary,
        fullText: sizeTier === PdfSizeTiers.LARGE ? null : fullText, // Don't store full text for large docs
        structuredData: null,
        sourceType: "pdf",
        pdfMetadata: {
          totalPages: pages.length,
          sizeTier,
          sections: summary.sections,
        },
      })

      // Update job status
      await PdfProcessingJobRepository.updateStatus(client, pdfJobId, PdfJobStatuses.COMPLETED)

      // Mark attachment as completed
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

  // ===========================================================================
  // Private helpers
  // ===========================================================================

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
      // Download PDF and render page as image
      const pdfBuffer = await this.storage.getObject(storagePath)
      const pdfData = new Uint8Array(pdfBuffer)
      const pdf = await getDocumentProxy(pdfData)
      const page = await pdf.getPage(pageNumber)

      // Render to canvas (using unpdf's built-in rendering)
      const viewport = page.getViewport({ scale: 2.0 }) // Higher scale for better OCR
      const canvas = new OffscreenCanvas(viewport.width, viewport.height)
      const context = canvas.getContext("2d")!

      await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise

      // Convert to blob for Tesseract
      const blob = await canvas.convertToBlob({ type: "image/png" })
      const arrayBuffer = await blob.arrayBuffer()

      // Run OCR (use Buffer since that's a supported ImageLike type)
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
      // Download PDF and render page as image
      const pdfBuffer = await this.storage.getObject(attachment.storagePath)
      const pdfData = new Uint8Array(pdfBuffer)
      const pdf = await getDocumentProxy(pdfData)
      const page = await pdf.getPage(pageNumber)

      // Render to image for vision model
      const viewport = page.getViewport({ scale: 2.0 })
      const canvas = new OffscreenCanvas(viewport.width, viewport.height)
      const context = canvas.getContext("2d")!

      await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise

      const blob = await canvas.convertToBlob({ type: "image/png" })
      const arrayBuffer = await blob.arrayBuffer()
      const base64 = Buffer.from(arrayBuffer).toString("base64")

      // Use Gemini to extract content
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
    // For mixed pages, use the same approach as complex layout
    // since we need to handle both text and images
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
    // Try to extract title from first line or heading
    const firstLine = content.split("\n")[0]?.trim()
    if (firstLine && firstLine.length < 100 && firstLine.length > 5) {
      return firstLine.replace(/^#\s*/, "") // Remove markdown heading
    }
    return null
  }

  private createSimpleSummary(content: string): string {
    // Create a simple summary for small documents
    const words = content.split(/\s+/).slice(0, 50)
    return words.join(" ") + (words.length === 50 ? "..." : "")
  }
}
