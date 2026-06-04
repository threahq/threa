import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import sharp from "sharp"
import * as db from "../../../db"
import { OutboxRepository } from "../../../lib/outbox"
import { AttachmentRepository } from "../repository"
import type { Attachment } from "../repository"
import { ImageThumbnailService } from "./service"

function buildAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "attach_1",
    workspaceId: "ws_1",
    streamId: "stream_1",
    messageId: "msg_1",
    uploadedBy: "usr_1",
    filename: "photo.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    storageProvider: "s3",
    storagePath: "ws_1/attach_1/photo.png",
    processingStatus: "completed",
    safetyStatus: "clean",
    e2eOnly: false,
    thumbnailStoragePath: null,
    width: null,
    height: null,
    createdAt: new Date(),
    ...overrides,
  }
}

function createService(sourceBuffer: Buffer = Buffer.alloc(0)) {
  const storage = {
    getObject: mock(async (_key: string): Promise<Buffer> => sourceBuffer),
    putObject: mock(async (_key: string, _body: Buffer, _contentType: string): Promise<void> => {}),
  }
  return {
    service: new ImageThumbnailService({ pool: {} as any, storage: storage as any }),
    storage,
  }
}

describe("ImageThumbnailService.generateThumbnail", () => {
  afterEach(() => {
    mock.restore()
  })

  it("resizes the image, stores a webp thumbnail, and emits dimensions", async () => {
    const png = await sharp({
      create: { width: 1600, height: 800, channels: 3, background: { r: 12, g: 34, b: 56 } },
    })
      .png()
      .toBuffer()

    const attachment = buildAttachment()
    spyOn(AttachmentRepository, "findById").mockResolvedValue(attachment)
    const updateSpy = spyOn(AttachmentRepository, "updateImageVariant").mockResolvedValue(true)
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
    spyOn(db, "withTransaction").mockImplementation((async (_pool: unknown, cb: (c: any) => Promise<any>) =>
      cb({})) as any)

    const { service, storage } = createService(png)

    await service.generateThumbnail("attach_1")

    expect(storage.putObject).toHaveBeenCalledTimes(1)
    const [key, body, contentType] = storage.putObject.mock.calls[0]
    expect(key).toBe("ws_1/attach_1/thumbnail.webp")
    expect(contentType).toBe("image/webp")
    // Resized down to the 640px longest-edge cap, encoded as webp.
    const meta = await sharp(body).metadata()
    expect(meta.format).toBe("webp")
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(640)
    expect(body.length).toBeLessThan(png.length)

    expect(updateSpy).toHaveBeenCalledWith(expect.anything(), "attach_1", {
      thumbnailStoragePath: "ws_1/attach_1/thumbnail.webp",
      width: 1600,
      height: 800,
    })
    expect(outboxSpy).toHaveBeenCalledWith(expect.anything(), "attachment:thumbnailed", {
      workspaceId: "ws_1",
      streamId: "stream_1",
      messageId: "msg_1",
      attachmentId: "attach_1",
      width: 1600,
      height: 800,
    })
  })

  async function buildAnimatedGif(frames: number, delayMs: number, width = 1600, height = 800): Promise<Buffer> {
    const frameBuffers: Buffer[] = []
    for (let i = 0; i < frames; i++) {
      const shade = (i * 37) % 256
      frameBuffers.push(
        await sharp({ create: { width, height, channels: 3, background: { r: shade, g: shade, b: 255 - shade } } })
          .png()
          .toBuffer()
      )
    }
    return sharp(frameBuffers, { join: { animated: true } })
      .gif({ delay: Array(frames).fill(delayMs), loop: 0 })
      .toBuffer()
  }

  it("keeps an animated GIF animated, resizing it to a webp thumbnail", async () => {
    // 6 frames at 100ms = 10fps, already under the 15fps cap → every frame kept.
    const gif = await buildAnimatedGif(6, 100)

    spyOn(AttachmentRepository, "findById").mockResolvedValue(
      buildAttachment({ mimeType: "image/gif", filename: "loop.gif" })
    )
    const updateSpy = spyOn(AttachmentRepository, "updateImageVariant").mockResolvedValue(true)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
    spyOn(db, "withTransaction").mockImplementation((async (_pool: unknown, cb: (c: any) => Promise<any>) =>
      cb({})) as any)

    const { service, storage } = createService(gif)

    await service.generateThumbnail("attach_1")

    const [key, body, contentType] = storage.putObject.mock.calls[0]
    expect(key).toBe("ws_1/attach_1/thumbnail.webp")
    expect(contentType).toBe("image/webp")
    const meta = await sharp(body, { animated: true }).metadata()
    expect(meta.format).toBe("webp")
    expect(meta.pages).toBe(6)
    // Source loops forever (loop: 0); the thumbnail must too.
    expect(meta.loop).toBe(0)
    expect(Math.max(meta.width ?? 0, meta.pageHeight ?? 0)).toBeLessThanOrEqual(640)
    expect(updateSpy).toHaveBeenCalledWith(expect.anything(), "attach_1", {
      thumbnailStoragePath: "ws_1/attach_1/thumbnail.webp",
      width: 1600,
      height: 800,
    })
  })

  it("caps a high-framerate GIF, dropping frames while staying animated", async () => {
    // 12 frames at 25ms = 40fps → downsampled below the 15fps cap.
    const gif = await buildAnimatedGif(12, 25)

    spyOn(AttachmentRepository, "findById").mockResolvedValue(
      buildAttachment({ mimeType: "image/gif", filename: "fast.gif" })
    )
    spyOn(AttachmentRepository, "updateImageVariant").mockResolvedValue(true)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
    spyOn(db, "withTransaction").mockImplementation((async (_pool: unknown, cb: (c: any) => Promise<any>) =>
      cb({})) as any)

    const { service, storage } = createService(gif)

    await service.generateThumbnail("attach_1")

    const body = storage.putObject.mock.calls[0][1] as Buffer
    const meta = await sharp(body, { animated: true }).metadata()
    expect(meta.format).toBe("webp")
    // Still animated, but with fewer frames than the 40fps source.
    expect(meta.pages ?? 1).toBeGreaterThan(1)
    expect(meta.pages ?? 1).toBeLessThan(12)
  })

  it("swaps width/height for EXIF orientations that rotate 90°", async () => {
    const rotated = await sharp({
      create: { width: 1200, height: 600, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer()

    spyOn(AttachmentRepository, "findById").mockResolvedValue(buildAttachment({ filename: "photo.jpg" }))
    const updateSpy = spyOn(AttachmentRepository, "updateImageVariant").mockResolvedValue(true)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
    spyOn(db, "withTransaction").mockImplementation((async (_pool: unknown, cb: (c: any) => Promise<any>) =>
      cb({})) as any)

    const { service } = createService(rotated)

    await service.generateThumbnail("attach_1")

    expect(updateSpy).toHaveBeenCalledWith(expect.anything(), "attach_1", {
      thumbnailStoragePath: "ws_1/attach_1/thumbnail.webp",
      width: 600,
      height: 1200,
    })
  })

  it("skips when the attachment already has a thumbnail", async () => {
    spyOn(AttachmentRepository, "findById").mockResolvedValue(
      buildAttachment({ thumbnailStoragePath: "ws_1/attach_1/thumbnail.webp" })
    )
    const { service, storage } = createService()

    await service.generateThumbnail("attach_1")

    expect(storage.getObject).not.toHaveBeenCalled()
    expect(storage.putObject).not.toHaveBeenCalled()
  })

  it("skips SVGs (rasterizing them is larger and blurry)", async () => {
    spyOn(AttachmentRepository, "findById").mockResolvedValue(
      buildAttachment({ mimeType: "image/svg+xml", filename: "logo.svg" })
    )
    const { service, storage } = createService()

    await service.generateThumbnail("attach_1")

    expect(storage.getObject).not.toHaveBeenCalled()
    expect(storage.putObject).not.toHaveBeenCalled()
  })

  it("is non-fatal when the image is corrupt/undecodable", async () => {
    spyOn(AttachmentRepository, "findById").mockResolvedValue(buildAttachment())
    const updateSpy = spyOn(AttachmentRepository, "updateImageVariant").mockResolvedValue(true)
    const { service, storage } = createService(Buffer.from("this is not an image"))

    await service.generateThumbnail("attach_1")

    expect(storage.putObject).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it("skips when the attachment no longer exists", async () => {
    spyOn(AttachmentRepository, "findById").mockResolvedValue(null)
    const { service, storage } = createService()

    await service.generateThumbnail("attach_1")

    expect(storage.getObject).not.toHaveBeenCalled()
  })

  it("does not emit a thumbnailed event when the row vanished before commit", async () => {
    const png = await sharp({
      create: { width: 800, height: 400, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .png()
      .toBuffer()

    spyOn(AttachmentRepository, "findById").mockResolvedValue(buildAttachment())
    spyOn(AttachmentRepository, "updateImageVariant").mockResolvedValue(false)
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
    spyOn(db, "withTransaction").mockImplementation((async (_pool: unknown, cb: (c: any) => Promise<any>) =>
      cb({})) as any)

    const { service } = createService(png)

    await service.generateThumbnail("attach_1")

    expect(outboxSpy).not.toHaveBeenCalled()
  })
})
