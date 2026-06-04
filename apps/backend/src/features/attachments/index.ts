// Repositories
export { AttachmentRepository } from "./repository"
export type { Attachment, InsertAttachmentParams, AttachmentWithExtraction } from "./repository"

export { AttachmentReferenceRepository } from "./reference-repository"
export type { AttachmentReference, InsertAttachmentReferenceParams } from "./reference-repository"

// Fallback access helper — `getDownloadUrl` and create-message validation
// both walk share-grant + inline-reference after their stream-access fast
// path fails. See `access.ts`.
export { isAttachmentReadableViaShareOrReference } from "./access"

// Wire-shape mappers
export { toAttachmentSummary } from "./summary"

export { AttachmentExtractionRepository } from "./extraction-repository"
export type {
  AttachmentExtraction,
  InsertAttachmentExtractionParams,
  PdfMetadata,
  PdfSection,
} from "./extraction-repository"

export { PdfPageExtractionRepository } from "./pdf/page-extraction-repository"
export type {
  PdfPageExtraction,
  EmbeddedImage,
  InsertPdfPageExtractionParams,
  UpdatePdfPageExtractionParams,
} from "./pdf/page-extraction-repository"

export { PdfProcessingJobRepository } from "./pdf/job-repository"
export type { PdfProcessingJob, InsertPdfProcessingJobParams } from "./pdf/job-repository"

// Service
export { AttachmentService, buildUploadParams, parseE2eUploadFlag } from "./service"
export type { CreateAttachmentParams, UploadedFileFacts } from "./service"

// Handlers
export { createAttachmentHandlers } from "./handlers"

// Outbox handlers
export { AttachmentUploadedHandler } from "./uploaded-outbox-handler"
export { AttachmentEmbeddingHandler } from "./embedding-outbox-handler"
export type { AttachmentEmbeddingHandlerConfig } from "./embedding-outbox-handler"

// Embedding worker
export { createAttachmentEmbeddingWorker } from "./embedding-worker"
export type { AttachmentEmbeddingWorkerDeps } from "./embedding-worker"
export { isContentTypeEmbeddable, MIN_SUMMARY_LENGTH } from "./embedding-config"

// Await processing
export { awaitAttachmentProcessing, hasPendingAttachmentProcessing } from "./await-processing"
export type { AwaitAttachmentProcessingResult } from "./await-processing"

// Upload safety policy
export { createMalwareScanner, isAttachmentSafeForSharing, safetyStatusBlockReason } from "./upload-safety-policy"
export type {
  AttachmentSafetyPolicy,
  MalwareScanner,
  MalwareScanInput,
  MalwareScanResult,
} from "./upload-safety-policy"

// Sub-feature re-exports
export { ImageCaptionService, StubImageCaptionService, isImageAttachment } from "./image-caption"
export type { ImageCaptionServiceDeps, ImageCaptionServiceLike } from "./image-caption"

export { ImageThumbnailService, shouldGenerateThumbnail } from "./image"
export type { ImageThumbnailServiceDeps, ImageThumbnailServiceLike } from "./image"

export { PdfProcessingService, StubPdfProcessingService, isPdfAttachment } from "./pdf"
export type { PdfProcessingServiceLike, PdfProcessingServiceDeps } from "./pdf"

export { TextProcessingService, StubTextProcessingService } from "./text"
export type { TextProcessingServiceDeps, TextProcessingServiceLike } from "./text"

export { WordProcessingService, StubWordProcessingService, isWordAttachment } from "./word"
export type { WordProcessingServiceDeps, WordProcessingServiceLike } from "./word"

export {
  ExcelProcessingService,
  StubExcelProcessingService,
  isExcelAttachment,
  EXCEL_MAX_ROWS_PER_REQUEST,
} from "./excel"
export type { ExcelProcessingServiceDeps, ExcelProcessingServiceLike } from "./excel"

export {
  VideoTranscodingService,
  StubVideoTranscodingService,
  ThreaMediaConvertClient,
  VideoTranscodeJobRepository,
  isVideoAttachment,
} from "./video"
export type { VideoTranscodingServiceDeps, VideoTranscodingServiceLike } from "./video"

// Workers
export { createImageCaptionWorker } from "./image-caption/worker"
export { createImageThumbnailWorker } from "./image/worker"
export { createPdfPrepareWorker } from "./pdf/prepare-worker"
export { createPdfPageWorker } from "./pdf/page-worker"
export { createPdfAssembleWorker } from "./pdf/assemble-worker"
export { createTextProcessingWorker } from "./text/worker"
export { createWordProcessingWorker } from "./word/worker"
export { createExcelProcessingWorker } from "./excel/worker"
export { createVideoTranscodeSubmitWorker } from "./video/submit-worker"
export { createVideoTranscodeCheckWorker } from "./video/check-worker"
