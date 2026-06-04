import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { AttachmentSafetyStatuses } from "@threa/types"
import * as db from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { AttachmentRepository, type Attachment } from "./repository"
import { AttachmentReferenceRepository } from "./reference-repository"
import { AttachmentExtractionRepository } from "./extraction-repository"
import {
  AttachmentService,
  buildUploadParams,
  parseE2eUploadFlag,
  E2E_PLACEHOLDER_FILENAME,
  E2E_PLACEHOLDER_MIME_TYPE,
  type UploadedFileFacts,
} from "./service"

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "attach_1",
    workspaceId: "ws_1",
    streamId: "stream_origin",
    messageId: "msg_origin",
    uploadedBy: "usr_1",
    filename: "f.png",
    mimeType: "image/png",
    sizeBytes: 1,
    storageProvider: "s3",
    storagePath: "k",
    processingStatus: "completed",
    safetyStatus: AttachmentSafetyStatuses.CLEAN,
    e2eOnly: false,
    thumbnailStoragePath: null,
    width: null,
    height: null,
    createdAt: new Date(),
    ...overrides,
  }
}

function createService() {
  const storage = {
    getObjectSize: mock(async () => 0),
    getSignedDownloadUrl: mock(async () => "https://example.com/file"),
    delete: mock(async () => {}),
  } as any

  const malwareScanner = {
    scan: mock(async () => ({ status: AttachmentSafetyStatuses.CLEAN })),
  } as any

  return {
    service: new AttachmentService({} as any, storage, malwareScanner),
    storage,
    malwareScanner,
  }
}

describe("AttachmentService", () => {
  afterEach(() => {
    mock.restore()
  })

  it("deletes attachment metadata in transaction before deleting S3 object", async () => {
    const steps: string[] = []
    spyOn(db, "withTransaction").mockImplementation((async (_db: unknown, callback: (client: any) => Promise<any>) => {
      steps.push("transaction:start")
      const result = await callback({})
      steps.push("transaction:end")
      return result
    }) as any)

    spyOn(AttachmentRepository, "findByIdForUpdate").mockImplementation(async () => {
      steps.push("attachment:lock")
      return {
        id: "attach_1",
        workspaceId: "ws_1",
        streamId: null,
        messageId: null,
        uploadedBy: "usr_1",
        filename: "unsafe.exe",
        mimeType: "application/octet-stream",
        sizeBytes: 10,
        storageProvider: "s3",
        storagePath: "ws_1/attach_1/unsafe.exe",
        processingStatus: "pending",
        safetyStatus: "quarantined",
        createdAt: new Date(),
      } as any
    })
    spyOn(AttachmentExtractionRepository, "deleteByAttachmentId").mockImplementation(async () => {
      steps.push("extraction:delete")
      return true
    })
    spyOn(AttachmentRepository, "delete").mockImplementation(async () => {
      steps.push("attachment:delete")
      return true
    })

    const { service, storage } = createService()
    storage.delete = mock(async () => {
      steps.push("storage:delete")
    })

    const deleted = await service.delete("attach_1")

    expect(deleted).toBe(true)
    expect(steps).toEqual([
      "transaction:start",
      "attachment:lock",
      "extraction:delete",
      "attachment:delete",
      "transaction:end",
      "storage:delete",
    ])
  })

  it("returns false when attachment does not exist", async () => {
    spyOn(db, "withTransaction").mockImplementation((async (_db: unknown, callback: (client: any) => Promise<any>) =>
      callback({})) as any)
    spyOn(AttachmentRepository, "findByIdForUpdate").mockResolvedValue(null)
    spyOn(AttachmentExtractionRepository, "deleteByAttachmentId").mockResolvedValue(true)
    spyOn(AttachmentRepository, "delete").mockResolvedValue(true)

    const { service, storage } = createService()
    const deleted = await service.delete("attach_missing")

    expect(deleted).toBe(false)
    expect(AttachmentExtractionRepository.deleteByAttachmentId).not.toHaveBeenCalled()
    expect(AttachmentRepository.delete).not.toHaveBeenCalled()
    expect(storage.delete).not.toHaveBeenCalled()
  })

  it("recovers attachment size from storage when the upload middleware reports zero bytes", async () => {
    spyOn(db, "withTransaction").mockImplementation((async (_db: unknown, callback: (client: any) => Promise<any>) =>
      callback({})) as any)

    const insertSpy = spyOn(AttachmentRepository, "insert").mockImplementation(async (_client, params) => ({
      id: params.id,
      workspaceId: params.workspaceId,
      streamId: null,
      messageId: null,
      uploadedBy: params.uploadedBy,
      filename: params.filename,
      mimeType: params.mimeType,
      sizeBytes: params.sizeBytes,
      storageProvider: "s3",
      storagePath: params.storagePath,
      processingStatus: params.processingStatus ?? "pending",
      safetyStatus: params.safetyStatus ?? AttachmentSafetyStatuses.PENDING_SCAN,
      e2eOnly: params.e2eOnly ?? false,
      thumbnailStoragePath: null,
      width: null,
      height: null,
      createdAt: new Date(),
    }))
    spyOn(AttachmentRepository, "updateSafetyStatus").mockResolvedValue(true)
    spyOn(AttachmentRepository, "findById").mockResolvedValue({
      id: "attach_1",
      workspaceId: "ws_1",
      streamId: null,
      messageId: null,
      uploadedBy: "usr_1",
      filename: "test.png",
      mimeType: "image/png",
      sizeBytes: 4096,
      storageProvider: "s3",
      storagePath: "ws_1/attach_1/test.png",
      processingStatus: "pending",
      safetyStatus: AttachmentSafetyStatuses.CLEAN,
      createdAt: new Date(),
    } as any)
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

    const { service, storage } = createService()
    storage.getObjectSize = mock(async () => 4096)

    const attachment = await service.create({
      id: "attach_1",
      workspaceId: "ws_1",
      uploadedBy: "usr_1",
      filename: "test.png",
      mimeType: "image/png",
      sizeBytes: 0,
      storagePath: "ws_1/attach_1/test.png",
    })

    expect(storage.getObjectSize).toHaveBeenCalledWith("ws_1/attach_1/test.png")
    expect(insertSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sizeBytes: 4096,
      })
    )
    expect(outboxSpy).toHaveBeenCalledWith(
      expect.anything(),
      "attachment:uploaded",
      expect.objectContaining({
        sizeBytes: 4096,
      })
    )
    expect(attachment.sizeBytes).toBe(4096)
  })

  describe("E2E uploads", () => {
    function spyInsertEcho() {
      return spyOn(AttachmentRepository, "insert").mockImplementation(async (_client, params) => ({
        id: params.id,
        workspaceId: params.workspaceId,
        streamId: null,
        messageId: null,
        uploadedBy: params.uploadedBy,
        filename: params.filename,
        mimeType: params.mimeType,
        sizeBytes: params.sizeBytes,
        storageProvider: "s3",
        storagePath: params.storagePath,
        processingStatus: params.processingStatus ?? "pending",
        safetyStatus: params.safetyStatus ?? AttachmentSafetyStatuses.PENDING_SCAN,
        e2eOnly: params.e2eOnly ?? false,
        thumbnailStoragePath: null,
        width: null,
        height: null,
        createdAt: new Date(),
      }))
    }

    it("skips the malware scan, emits no processor event, and persists e2e_unscanned + skipped", async () => {
      spyOn(db, "withTransaction").mockImplementation((async (_db: unknown, callback: (client: any) => Promise<any>) =>
        callback({})) as any)
      const insertSpy = spyInsertEcho()
      const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

      const { service, malwareScanner } = createService()

      const attachment = await service.create({
        id: "attach_e2e",
        workspaceId: "ws_1",
        uploadedBy: "usr_1",
        filename: "encrypted",
        mimeType: "application/octet-stream",
        sizeBytes: 2048,
        storagePath: "ws_1/attach_e2e/encrypted",
        e2e: true,
      })

      // The scanner never runs on ciphertext, and no processor work is dispatched.
      expect(malwareScanner.scan).not.toHaveBeenCalled()
      expect(outboxSpy).not.toHaveBeenCalled()

      expect(insertSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          e2eOnly: true,
          safetyStatus: AttachmentSafetyStatuses.E2E_UNSCANNED,
          processingStatus: "skipped",
        })
      )
      expect(attachment).toMatchObject({
        e2eOnly: true,
        safetyStatus: AttachmentSafetyStatuses.E2E_UNSCANNED,
        processingStatus: "skipped",
      })
    })

    it("treats an E2E upload as shareable (download allowed despite never being scanned)", async () => {
      const { service } = createService()
      expect(
        service.getSharingBlockReason(makeAttachment({ safetyStatus: AttachmentSafetyStatuses.E2E_UNSCANNED }))
      ).toBeNull()
    })
  })

  it("fails loudly when storage cannot determine the object size", async () => {
    const insertSpy = spyOn(AttachmentRepository, "insert")
    const outboxSpy = spyOn(OutboxRepository, "insert")
    const { service, storage } = createService()
    storage.getObjectSize = mock(async () => {
      throw new Error("S3 HeadObject missing valid ContentLength for key: ws_1/attach_1/empty.txt")
    })

    await expect(
      service.create({
        id: "attach_1",
        workspaceId: "ws_1",
        uploadedBy: "usr_1",
        filename: "empty.txt",
        mimeType: "text/plain",
        sizeBytes: 0,
        storagePath: "ws_1/attach_1/empty.txt",
      })
    ).rejects.toThrow("S3 HeadObject missing valid ContentLength for key: ws_1/attach_1/empty.txt")

    expect(insertSpy).not.toHaveBeenCalled()
    expect(outboxSpy).not.toHaveBeenCalled()
  })

  it("quarantines stale pending scans and returns recovered count", async () => {
    spyOn(db, "withTransaction").mockImplementation((async (_db: unknown, callback: (client: any) => Promise<any>) =>
      callback({})) as any)
    const quarantineSpy = spyOn(AttachmentRepository, "quarantineStalePendingScans").mockResolvedValue([
      "attach_1",
      "attach_2",
    ])

    const { service } = createService()
    const recovered = await service.recoverStalePendingScans({ staleThresholdMs: 60_000, batchSize: 25 })

    expect(recovered).toBe(2)
    expect(quarantineSpy).toHaveBeenCalledTimes(1)
    expect(quarantineSpy.mock.calls[0]?.[1]?.limit).toBe(25)
    expect(quarantineSpy.mock.calls[0]?.[1]?.olderThan).toBeInstanceOf(Date)
  })

  it("rejects invalid recovery options", async () => {
    spyOn(db, "withTransaction").mockImplementation((async (_db: unknown, callback: (client: any) => Promise<any>) =>
      callback({})) as any)

    const { service } = createService()

    await expect(service.recoverStalePendingScans({ staleThresholdMs: 0 })).rejects.toThrow(
      "staleThresholdMs must be positive"
    )
    await expect(service.recoverStalePendingScans({ batchSize: 0 })).rejects.toThrow("batchSize must be positive")
  })

  describe("getAccessible", () => {
    it("returns the attachment when its owning stream is in the accessible set", async () => {
      spyOn(AttachmentRepository, "findById").mockResolvedValue(makeAttachment({ streamId: "stream_a" }))
      const refSpy = spyOn(AttachmentReferenceRepository, "findReferencingStreamIds").mockResolvedValue([])

      const { service } = createService()
      const result = await service.getAccessible("attach_1", { workspaceId: "ws_1", accessibleStreamIds: ["stream_a"] })

      expect(result?.id).toBe("attach_1")
      expect(refSpy).not.toHaveBeenCalled()
    })

    it("returns the attachment when a reference points to an accessible stream", async () => {
      spyOn(AttachmentRepository, "findById").mockResolvedValue(makeAttachment({ streamId: "stream_origin" }))
      const refSpy = spyOn(AttachmentReferenceRepository, "findReferencingStreamIds").mockResolvedValue([
        "stream_b",
        "stream_other",
      ])

      const { service } = createService()
      const result = await service.getAccessible("attach_1", { workspaceId: "ws_1", accessibleStreamIds: ["stream_b"] })

      expect(result?.id).toBe("attach_1")
      expect(refSpy).toHaveBeenCalledTimes(1)
    })

    it("returns null when neither the owning stream nor any reference is accessible", async () => {
      spyOn(AttachmentRepository, "findById").mockResolvedValue(makeAttachment({ streamId: "stream_origin" }))
      spyOn(AttachmentReferenceRepository, "findReferencingStreamIds").mockResolvedValue(["stream_other"])

      const { service } = createService()
      const result = await service.getAccessible("attach_1", { workspaceId: "ws_1", accessibleStreamIds: ["stream_a"] })

      expect(result).toBeNull()
    })

    it("returns null when the attachment is unanchored (streamId null) and has no references", async () => {
      spyOn(AttachmentRepository, "findById").mockResolvedValue(makeAttachment({ streamId: null, messageId: null }))
      spyOn(AttachmentReferenceRepository, "findReferencingStreamIds").mockResolvedValue([])

      const { service } = createService()
      const result = await service.getAccessible("attach_1", { workspaceId: "ws_1", accessibleStreamIds: ["stream_a"] })

      expect(result).toBeNull()
    })

    it("returns null when the attachment belongs to another workspace", async () => {
      spyOn(AttachmentRepository, "findById").mockResolvedValue(makeAttachment({ workspaceId: "ws_other" }))
      const refSpy = spyOn(AttachmentReferenceRepository, "findReferencingStreamIds").mockResolvedValue([])

      const { service } = createService()
      const result = await service.getAccessible("attach_1", {
        workspaceId: "ws_1",
        accessibleStreamIds: ["stream_origin"],
      })

      expect(result).toBeNull()
      expect(refSpy).not.toHaveBeenCalled()
    })

    it("returns null when the attachment is sharing-blocked even if the stream is accessible", async () => {
      spyOn(AttachmentRepository, "findById").mockResolvedValue(
        makeAttachment({ streamId: "stream_a", safetyStatus: AttachmentSafetyStatuses.QUARANTINED })
      )

      const { service } = createService()
      const result = await service.getAccessible("attach_1", { workspaceId: "ws_1", accessibleStreamIds: ["stream_a"] })

      expect(result).toBeNull()
    })
  })
})

// The single chokepoint both upload entry points (first-party + public API)
// delegate to, so the "E2E ⇒ no real metadata on the server" rule is proven
// once for both paths.
describe("buildUploadParams", () => {
  const file: UploadedFileFacts = {
    id: "attach_1",
    workspaceId: "ws_1",
    uploadedBy: "usr_1",
    filename: "Q3-layoffs.xlsx",
    mimeType: "application/vnd.ms-excel",
    sizeBytes: 2048,
    storagePath: "ws_1/attach_1/Q3-layoffs.xlsx",
  }

  it("keeps real metadata and leaves e2e off for a normal upload", () => {
    expect(buildUploadParams(file, false)).toEqual({ ...file, e2e: false })
  })

  it("replaces the real filename/mime with placeholders for an E2E upload", () => {
    const params = buildUploadParams(file, true)
    expect(params).toEqual({
      ...file,
      filename: E2E_PLACEHOLDER_FILENAME,
      mimeType: E2E_PLACEHOLDER_MIME_TYPE,
      e2e: true,
    })
    // The real name must never survive onto the params the server persists.
    expect(params.filename).not.toBe(file.filename)
    expect(params.mimeType).not.toBe(file.mimeType)
    // Ciphertext size is the one fact that can't be hidden — it's the S3 object.
    expect(params.sizeBytes).toBe(2048)
  })
})

describe("parseE2eUploadFlag", () => {
  it("reads the multipart string flag and defaults to false", () => {
    expect(parseE2eUploadFlag({ e2e: "true" })).toBe(true)
    expect(parseE2eUploadFlag({ e2e: true })).toBe(true)
    expect(parseE2eUploadFlag({ e2e: "false" })).toBe(false)
    expect(parseE2eUploadFlag({})).toBe(false)
    expect(parseE2eUploadFlag(undefined)).toBe(false)
  })
})
