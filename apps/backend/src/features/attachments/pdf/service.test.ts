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
    const findAttachment = spyOn(AttachmentRepository, "findById").mockResolvedValue({
      id: "attach_1",
      workspaceId: "ws_1",
      storagePath: "ws_1/attach_1.pdf",
    } as never)
    const findPage = spyOn(PdfPageExtractionRepository, "findByAttachmentAndPage").mockResolvedValue({
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

    await expect(service.processPage("ws_1", "attach_1", 1, "pdfjob_1")).rejects.toBe(denial)

    expect({
      attachmentLookup: findAttachment.mock.calls.map((call) => call.slice(1)),
      pageLookup: findPage.mock.calls.map((call) => call.slice(1)),
      statusClaims: updateStatus.mock.calls.map((call) => call.slice(1, 4)),
      pagesFailed: incrementFailed.mock.calls.length,
      assembleChecks: isAllDone.mock.calls.length,
    }).toEqual({
      attachmentLookup: [["ws_1", "attach_1"]],
      pageLookup: [["ws_1", "attach_1", 1]],
      statusClaims: [["ws_1", "pdfpage_1", ProcessingStatuses.PROCESSING]],
      pagesFailed: 0,
      assembleChecks: 0,
    })
  })

  it("should fail the page and count it against the job in the job's workspace when page processing rejects", async () => {
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
    const service = new PdfProcessingService({
      pool: {} as never,
      ai: {} as never,
      storage: {} as never,
      jobQueue: {} as never,
    })
    spyOn(service as never, "processComplexPage").mockRejectedValue(new Error("vision failed") as never)

    await service.processPage("ws_1", "attach_1", 1, "pdfjob_1")

    expect({
      statusWrites: updateStatus.mock.calls.map((call) => call.slice(1)),
      pagesFailed: incrementFailed.mock.calls.map((call) => call.slice(1)),
      assembleChecks: isAllDone.mock.calls.map((call) => call.slice(1)),
    }).toEqual({
      statusWrites: [
        [
          "ws_1",
          "pdfpage_1",
          ProcessingStatuses.PROCESSING,
          {
            onlyIfStatusIn: [ProcessingStatuses.PENDING, ProcessingStatuses.PROCESSING, ProcessingStatuses.FAILED],
          },
        ],
        ["ws_1", "pdfpage_1", ProcessingStatuses.FAILED, { errorMessage: "vision failed" }],
      ],
      pagesFailed: [["ws_1", "pdfjob_1"]],
      assembleChecks: [["ws_1", "pdfjob_1"]],
    })
  })

  it("should queue the assemble job with the workspace when the last page completes without a model call", async () => {
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
      classification: PdfPageClassifications.TEXT_RICH,
      processingStatus: ProcessingStatuses.PENDING,
    } as never)
    spyOn(PdfPageExtractionRepository, "updateProcessingStatus").mockResolvedValue(true as never)
    spyOn(PdfPageExtractionRepository, "update").mockResolvedValue(undefined as never)
    const incrementCompleted = spyOn(PdfProcessingJobRepository, "incrementPagesCompleted").mockResolvedValue(
      undefined as never
    )
    const isAllDone = spyOn(PdfProcessingJobRepository, "isAllPagesProcessed").mockResolvedValue(true)
    const send = mock(async () => "job_1")

    const service = new PdfProcessingService({
      pool: {} as never,
      ai: {} as never,
      storage: {} as never,
      jobQueue: { send } as never,
    })

    await service.processPage("ws_1", "attach_1", 1, "pdfjob_1")

    expect({
      completedIncrements: incrementCompleted.mock.calls.map((call) => call.slice(1)),
      allDoneChecks: isAllDone.mock.calls.map((call) => call.slice(1)),
      assembleJobs: send.mock.calls.map((call: unknown[]) => call.slice(1)),
    }).toEqual({
      completedIncrements: [["ws_1", "pdfjob_1"]],
      allDoneChecks: [["ws_1", "pdfjob_1"]],
      assembleJobs: [[{ workspaceId: "ws_1", attachmentId: "attach_1", pdfJobId: "pdfjob_1" }]],
    })
  })
})
