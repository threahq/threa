import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { ExtractionContentTypes } from "@threahq/types"
import { AttachmentExtractionRepository, type AttachmentExtraction } from "./extraction-repository"
import { createAttachmentEmbeddingWorker } from "./embedding-worker"
import type { EmbeddingServiceLike } from "../memos"
import type { Job, AttachmentEmbeddingJobData } from "../../lib/queue"

function makeExtraction(overrides: Partial<AttachmentExtraction> = {}): AttachmentExtraction {
  return {
    id: "extract_1",
    attachmentId: "attach_1",
    workspaceId: "ws_1",
    contentType: ExtractionContentTypes.DOCUMENT,
    summary: "A quarterly revenue report broken down by product line.",
    fullText: "Revenue grew 17% year-over-year, driven by enterprise renewals.",
    structuredData: null,
    sourceType: "pdf",
    pdfMetadata: null,
    textMetadata: null,
    wordMetadata: null,
    excelMetadata: null,
    hasSummaryEmbedding: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeEmbeddingService(): EmbeddingServiceLike & { embed: ReturnType<typeof mock> } {
  return {
    embed: mock(async () => new Array(1536).fill(0.1)),
    embedBatch: mock(async (texts: string[]) => texts.map(() => new Array(1536).fill(0.1))),
  } as unknown as EmbeddingServiceLike & { embed: ReturnType<typeof mock> }
}

function makeJob(): Job<AttachmentEmbeddingJobData> {
  return {
    id: "queue_1",
    name: "attachment.embed",
    data: { attachmentId: "attach_1", workspaceId: "ws_1" },
  }
}

describe("createAttachmentEmbeddingWorker", () => {
  afterEach(() => {
    mock.restore()
  })

  it("generates and stores an embedding for an eligible extraction", async () => {
    spyOn(AttachmentExtractionRepository, "findByAttachmentId").mockResolvedValue(makeExtraction())
    const updateSpy = spyOn(AttachmentExtractionRepository, "updateSummaryEmbedding").mockResolvedValue(true)
    const embeddingService = makeEmbeddingService()

    const worker = createAttachmentEmbeddingWorker({ pool: {} as any, embeddingService })
    await worker(makeJob())

    expect(embeddingService.embed).toHaveBeenCalledTimes(1)
    expect(embeddingService.embed).toHaveBeenCalledWith("A quarterly revenue report broken down by product line.", {
      workspaceId: "ws_1",
      functionId: "attachment-summary-embedding",
    })
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy.mock.calls[0]?.[1]).toBe("ws_1")
    expect(updateSpy.mock.calls[0]?.[2]).toBe("attach_1")
    expect(updateSpy.mock.calls[0]?.[3]).toHaveLength(1536)
  })

  it("skips when the extraction is missing", async () => {
    spyOn(AttachmentExtractionRepository, "findByAttachmentId").mockResolvedValue(null)
    const updateSpy = spyOn(AttachmentExtractionRepository, "updateSummaryEmbedding").mockResolvedValue(true)
    const embeddingService = makeEmbeddingService()

    const worker = createAttachmentEmbeddingWorker({ pool: {} as any, embeddingService })
    await worker(makeJob())

    expect(embeddingService.embed).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it("skips ineligible content types (photo) even if a job slips through the handler filter", async () => {
    spyOn(AttachmentExtractionRepository, "findByAttachmentId").mockResolvedValue(
      makeExtraction({ contentType: ExtractionContentTypes.PHOTO })
    )
    const updateSpy = spyOn(AttachmentExtractionRepository, "updateSummaryEmbedding").mockResolvedValue(true)
    const embeddingService = makeEmbeddingService()

    const worker = createAttachmentEmbeddingWorker({ pool: {} as any, embeddingService })
    await worker(makeJob())

    expect(embeddingService.embed).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it("skips ineligible content types (other)", async () => {
    spyOn(AttachmentExtractionRepository, "findByAttachmentId").mockResolvedValue(
      makeExtraction({ contentType: ExtractionContentTypes.OTHER })
    )
    const updateSpy = spyOn(AttachmentExtractionRepository, "updateSummaryEmbedding").mockResolvedValue(true)
    const embeddingService = makeEmbeddingService()

    const worker = createAttachmentEmbeddingWorker({ pool: {} as any, embeddingService })
    await worker(makeJob())

    expect(embeddingService.embed).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it("skips when the summary is too short to carry signal", async () => {
    spyOn(AttachmentExtractionRepository, "findByAttachmentId").mockResolvedValue(makeExtraction({ summary: "  hi  " }))
    const updateSpy = spyOn(AttachmentExtractionRepository, "updateSummaryEmbedding").mockResolvedValue(true)
    const embeddingService = makeEmbeddingService()

    const worker = createAttachmentEmbeddingWorker({ pool: {} as any, embeddingService })
    await worker(makeJob())

    expect(embeddingService.embed).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it("refuses to write when the workspace in the payload doesn't match the extraction (INV-8)", async () => {
    spyOn(AttachmentExtractionRepository, "findByAttachmentId").mockResolvedValue(
      makeExtraction({ workspaceId: "ws_other" })
    )
    const updateSpy = spyOn(AttachmentExtractionRepository, "updateSummaryEmbedding").mockResolvedValue(true)
    const embeddingService = makeEmbeddingService()

    const worker = createAttachmentEmbeddingWorker({ pool: {} as any, embeddingService })
    await worker(makeJob())

    expect(embeddingService.embed).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it("tolerates the extraction being deleted between fetch and write", async () => {
    spyOn(AttachmentExtractionRepository, "findByAttachmentId").mockResolvedValue(makeExtraction())
    const updateSpy = spyOn(AttachmentExtractionRepository, "updateSummaryEmbedding").mockResolvedValue(false)
    const embeddingService = makeEmbeddingService()

    const worker = createAttachmentEmbeddingWorker({ pool: {} as any, embeddingService })
    await worker(makeJob())

    expect(embeddingService.embed).toHaveBeenCalledTimes(1)
    expect(updateSpy).toHaveBeenCalledTimes(1)
  })
})
