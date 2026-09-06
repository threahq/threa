import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { ProcessingStatuses } from "@threahq/types"
import * as db from "../../../db"
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

function createService() {
  const mediaConvertClient = {
    submitTranscodeJob: mock(async () => "mc_123"),
    getJobStatus: mock(async () => ({ status: "SUBMITTED" as const })),
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
    spyOn(AttachmentRepository, "findById").mockResolvedValue(buildAttachment(ProcessingStatuses.PENDING) as any)
    spyOn(VideoTranscodeJobRepository, "findByAttachmentId").mockResolvedValue(null)
    spyOn(AttachmentRepository, "updateProcessingStatus").mockResolvedValue(true)
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
    await service.submit("attach_1")

    expect(mediaConvertClient.submitTranscodeJob).toHaveBeenCalledWith({
      clientRequestToken: "attach_1",
      s3InputKey: "ws_1/attach_1/demo.mov",
      s3OutputPrefix: "ws_1/attach_1/",
    })
    expect(updateSubmittedSpy).toHaveBeenCalledWith(expect.anything(), "vtj_1", "mc_123")
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
    await service.submit("attach_1")

    expect(updateProcessingStatusSpy).not.toHaveBeenCalled()
    expect(upsertSpy).not.toHaveBeenCalled()
    expect(mediaConvertClient.submitTranscodeJob).not.toHaveBeenCalled()
  })
})
