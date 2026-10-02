import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { ProcessingStatuses } from "@threahq/types"
import * as db from "../../../db"
import { OutboxRepository } from "../../../lib/outbox"
import { AttachmentRepository } from "../repository"
import { VideoTranscodeJobRepository } from "./job-repository"
import { VideoTranscodingService } from "./service"

function buildAttachment(processingStatus: string) {
  return {
    id: "attach_1",
    workspaceId: "ws_1",
    streamId: "stream_1",
    messageId: "msg_1",
    uploadedBy: "usr_1",
    filename: "demo.mov",
    mimeType: "video/quicktime",
    sizeBytes: 1024,
    storageProvider: "s3",
    storagePath: "ws_1/attach_1/demo.mov",
    processingStatus,
    safetyStatus: "clean",
    createdAt: new Date(),
  }
}

function createService(jobStatus: { status: string; errorMessage?: string } = { status: "SUBMITTED" }) {
  const mediaConvertClient = {
    submitTranscodeJob: mock(async () => "mc_123"),
    getJobStatus: mock(async () => jobStatus),
  }

  return {
    service: new VideoTranscodingService({
      pool: {} as any,
      mediaConvertClient: mediaConvertClient as any,
      s3Config: {} as any,
    }),
    mediaConvertClient,
  }
}

describe("VideoTranscodingService.submit", () => {
  afterEach(() => {
    mock.restore()
  })

  it("passes a stable client request token when submitting MediaConvert jobs", async () => {
    spyOn(db, "withTransaction").mockImplementation((async (_db: unknown, callback: (client: any) => Promise<any>) =>
      callback({})) as any)
    const findSpy = spyOn(AttachmentRepository, "findById").mockResolvedValue(
      buildAttachment(ProcessingStatuses.PENDING) as any
    )
    const findJobSpy = spyOn(VideoTranscodeJobRepository, "findByAttachmentId").mockResolvedValue(null)
    const claimSpy = spyOn(AttachmentRepository, "updateProcessingStatus").mockResolvedValue(true)
    spyOn(VideoTranscodeJobRepository, "upsert").mockResolvedValue({
      id: "vtj_1",
      attachmentId: "attach_1",
      workspaceId: "ws_1",
      mediaconvertJobId: null,
      status: "pending",
      processedStoragePath: null,
      thumbnailStoragePath: null,
      errorMessage: null,
      submittedAt: null,
      completedAt: null,
      createdAt: new Date(),
    })
    const updateSubmittedSpy = spyOn(VideoTranscodeJobRepository, "updateSubmitted").mockResolvedValue(true)

    const { service, mediaConvertClient } = createService()
    await service.submit("ws_1", "attach_1")

    expect(mediaConvertClient.submitTranscodeJob).toHaveBeenCalledWith({
      clientRequestToken: "attach_1",
      s3InputKey: "ws_1/attach_1/demo.mov",
      s3OutputPrefix: "ws_1/attach_1/",
    })
    expect(findSpy).toHaveBeenCalledWith(expect.anything(), "ws_1", "attach_1")
    expect(findJobSpy).toHaveBeenCalledWith(expect.anything(), "ws_1", "attach_1")
    expect(claimSpy).toHaveBeenCalledWith(
      expect.anything(),
      "ws_1",
      "attach_1",
      ProcessingStatuses.PROCESSING,
      expect.anything()
    )
    expect(updateSubmittedSpy).toHaveBeenCalledWith(expect.anything(), "ws_1", "vtj_1", "mc_123")
  })

  it("skips duplicate submit when a processing attachment already has a MediaConvert job", async () => {
    spyOn(db, "withTransaction").mockImplementation((async (_db: unknown, callback: (client: any) => Promise<any>) =>
      callback({})) as any)
    spyOn(AttachmentRepository, "findById").mockResolvedValue(buildAttachment(ProcessingStatuses.PROCESSING) as any)
    spyOn(VideoTranscodeJobRepository, "findByAttachmentId").mockResolvedValue({
      id: "vtj_existing",
      attachmentId: "attach_1",
      workspaceId: "ws_1",
      mediaconvertJobId: "mc_existing",
      status: "submitted",
      processedStoragePath: null,
      thumbnailStoragePath: null,
      errorMessage: null,
      submittedAt: new Date(),
      completedAt: null,
      createdAt: new Date(),
    })
    const updateProcessingStatusSpy = spyOn(AttachmentRepository, "updateProcessingStatus").mockResolvedValue(true)
    const upsertSpy = spyOn(VideoTranscodeJobRepository, "upsert").mockResolvedValue({
      id: "vtj_ignored",
      attachmentId: "attach_1",
      workspaceId: "ws_1",
      mediaconvertJobId: null,
      status: "pending",
      processedStoragePath: null,
      thumbnailStoragePath: null,
      errorMessage: null,
      submittedAt: null,
      completedAt: null,
      createdAt: new Date(),
    })

    const { service, mediaConvertClient } = createService()
    await service.submit("ws_1", "attach_1")

    expect(updateProcessingStatusSpy).not.toHaveBeenCalled()
    expect(upsertSpy).not.toHaveBeenCalled()
    expect(mediaConvertClient.submitTranscodeJob).not.toHaveBeenCalled()
  })
})

describe("VideoTranscodingService.checkStatus", () => {
  afterEach(() => {
    mock.restore()
  })

  function spyOnSubmittedJob() {
    spyOn(db, "withTransaction").mockImplementation((async (_db: unknown, callback: (client: any) => Promise<any>) =>
      callback({})) as any)
    const findByAttachmentId = spyOn(VideoTranscodeJobRepository, "findByAttachmentId").mockResolvedValue({
      id: "vtj_1",
      attachmentId: "attach_1",
      workspaceId: "ws_1",
      mediaconvertJobId: "mc_123",
      status: "submitted",
      processedStoragePath: null,
      thumbnailStoragePath: null,
      errorMessage: null,
      submittedAt: new Date(),
      completedAt: null,
      createdAt: new Date(),
    })
    return {
      findByAttachmentId,
      updateProcessingStatus: spyOn(AttachmentRepository, "updateProcessingStatus").mockResolvedValue(true),
      findById: spyOn(AttachmentRepository, "findById").mockResolvedValue(buildAttachment("processing") as any),
      outboxInsert: spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as any),
    }
  }

  it("should scope every write and the transcoded event to the workspace when MediaConvert reports COMPLETE", async () => {
    const { findByAttachmentId, updateProcessingStatus, findById, outboxInsert } = spyOnSubmittedJob()
    const updateCompleted = spyOn(VideoTranscodeJobRepository, "updateCompleted").mockResolvedValue(true)

    const { service } = createService({ status: "COMPLETE" })
    const done = await service.checkStatus("ws_1", "attach_1")

    expect({
      done,
      jobLookups: findByAttachmentId.mock.calls.map((call) => call.slice(1)),
      jobCompletions: updateCompleted.mock.calls.map((call) => call.slice(1)),
      statusUpdates: updateProcessingStatus.mock.calls.map((call) => call.slice(1)),
      attachmentLookups: findById.mock.calls.map((call) => call.slice(1)),
      events: outboxInsert.mock.calls.map((call) => call.slice(1)),
    }).toEqual({
      done: true,
      jobLookups: [["ws_1", "attach_1"]],
      jobCompletions: [["ws_1", "vtj_1", "ws_1/attach_1/processed.mp4", "ws_1/attach_1/thumbnail.0000000.jpg"]],
      statusUpdates: [["ws_1", "attach_1", ProcessingStatuses.COMPLETED]],
      attachmentLookups: [["ws_1", "attach_1"]],
      events: [
        [
          "attachment:transcoded",
          {
            workspaceId: "ws_1",
            streamId: "stream_1",
            messageId: "msg_1",
            attachmentId: "attach_1",
            processingStatus: ProcessingStatuses.COMPLETED,
          },
        ],
      ],
    })
  })

  it("should scope every write and the transcoded event to the workspace when MediaConvert reports ERROR", async () => {
    const { findByAttachmentId, updateProcessingStatus, findById, outboxInsert } = spyOnSubmittedJob()
    const updateFailed = spyOn(VideoTranscodeJobRepository, "updateFailed").mockResolvedValue(true)

    const { service } = createService({ status: "ERROR", errorMessage: "bad codec" })
    const done = await service.checkStatus("ws_1", "attach_1")

    expect({
      done,
      jobLookups: findByAttachmentId.mock.calls.map((call) => call.slice(1)),
      jobFailures: updateFailed.mock.calls.map((call) => call.slice(1)),
      statusUpdates: updateProcessingStatus.mock.calls.map((call) => call.slice(1)),
      attachmentLookups: findById.mock.calls.map((call) => call.slice(1)),
      events: outboxInsert.mock.calls.map((call) => call.slice(1)),
    }).toEqual({
      done: true,
      jobLookups: [["ws_1", "attach_1"]],
      jobFailures: [["ws_1", "vtj_1", "bad codec"]],
      statusUpdates: [["ws_1", "attach_1", ProcessingStatuses.FAILED]],
      attachmentLookups: [["ws_1", "attach_1"]],
      events: [
        [
          "attachment:transcoded",
          {
            workspaceId: "ws_1",
            streamId: "stream_1",
            messageId: "msg_1",
            attachmentId: "attach_1",
            processingStatus: ProcessingStatuses.FAILED,
          },
        ],
      ],
    })
  })
})
