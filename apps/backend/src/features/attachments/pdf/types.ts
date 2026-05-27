import type { Pool } from "pg"
import type { AI } from "@threa/agent-runtime"
import type { StorageProvider } from "../../../lib/storage/s3-client"
import type { QueueManager } from "../../../lib/queue"
import type { PdfPageClassification, PdfSizeTier } from "@threa/types"

export interface PdfProcessingServiceDeps {
  pool: Pool
  ai: AI
  storage: StorageProvider
  jobQueue: QueueManager
}

export interface PdfProcessingServiceLike {
  /** Phase 1: Extract text/images, classify pages, create page records, fan out jobs */
  prepare(attachmentId: string): Promise<void>

  /** Phase 2: Process single page based on classification */
  processPage(attachmentId: string, pageNumber: number, pdfJobId: string): Promise<void>

  /** Phase 3: Combine page results, generate summary, create document extraction */
  assemble(attachmentId: string, pdfJobId: string): Promise<void>
}

export interface PageInfo {
  pageNumber: number
  classification: PdfPageClassification
  rawText: string | null
  embeddedImagePaths: string[]
}

export interface PdfExtractionResult {
  totalPages: number
  sizeTier: PdfSizeTier
  pages: PageInfo[]
}

export interface PageProcessingResult {
  pageNumber: number
  textContent: string | null
  embeddedImages: Array<{
    id: string
    storagePath: string
    caption: string | null
  }>
}

export interface DocumentSummary {
  title: string | null
  summary: string
  sections: Array<{
    startPage: number
    endPage: number
    title: string
  }>
  fullText: string
}
