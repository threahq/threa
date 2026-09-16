import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import { AISpendDeniedError } from "@threahq/agent-runtime"
import { PdfPageClassifications, ProcessingStatuses } from "@threahq/types"
import * as dbModule from "../../../db"
import { AttachmentRepository } from "../repository"
import { PdfPageExtractionRepository } from "./page-extraction-repository"
import { PdfProcessingJobRepository } from "./job-repository"
import { PdfProcessingService } from "./service"

describe("PdfProcessingService.processPage", () => {
  afterEach(() => mock.restore())

  it("should leave the page claimable and propagate a spend denial instead of failing the page", async () => {
    const fakeClient = {} as PoolClient
    spyOn(dbModule, "withClient").mockImplementation((async (_pool: unknown, fn: (c: PoolClient) => unknown) =>
      fn(fakeClient)) as typeof dbModule.withClient)
    spyOn(dbModule, "withTransaction").mockImplementation((async (_pool: unknown, fn: (c: PoolClient) => unknown) =>
      fn(fakeClient)) as typeof dbModule.withTransaction)
    spyOn(AttachmentRepository, "findById").mockResolvedValue({
      id: "attach_1",
      workspaceId: "ws_1",
      storagePath: "ws_1/attach_1.pdf",
    } as never)
    spyOn(PdfPageExtractionRepository, "findByAttachmentAndPage").mockResolvedValue({
      id: "pdfpage_1",
      classification: PdfPageClassifications.COMPLEX_LAYOUT,
      processingStatus: ProcessingStatuses.PENDING,
    } as never)
    const updateStatus = spyOn(PdfPageExtractionRepository, "updateProcessingStatus").mockResolvedValue(true as never)
    const incrementFailed = spyOn(PdfProcessingJobRepository, "incrementPagesFailed").mockResolvedValue(
      undefined as never
    )
    const isAllDone = spyOn(PdfProcessingJobRepository, "isAllPagesProcessed").mockResolvedValue(false)

    const denial = new AISpendDeniedError(
      { workspaceId: "ws_1", functionId: "pdf-layout-extraction" },
      "workspace_limit"
    )
    const service = new PdfProcessingService({
      pool: {} as never,
      ai: {} as never,
      storage: {} as never,
      jobQueue: {} as never,
    })
    spyOn(service as never, "processComplexPage").mockRejectedValue(denial as never)

    await expect(service.processPage("attach_1", 1, "pdfjob_1")).rejects.toBe(denial)

    expect({
      statuses: updateStatus.mock.calls.map((call) => call[2]),
      pagesFailed: incrementFailed.mock.calls.length,
      assembleChecks: isAllDone.mock.calls.length,
    }).toEqual({ statuses: [ProcessingStatuses.PROCESSING], pagesFailed: 0, assembleChecks: 0 })
  })
})
