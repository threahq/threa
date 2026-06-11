import { createHash } from "node:crypto"
import { once } from "node:events"
import { Readable, Writable } from "node:stream"
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { AttachmentSafetyStatuses } from "@threa/types"
import { createAttachmentHandlers } from "./handlers"
import { SharedMessageRepository } from "../messaging"
import { AttachmentReferenceRepository } from "./reference-repository"
import { AttachmentRepository, type AttachmentSearchRow } from "./repository"
import { VideoTranscodeJobRepository } from "./video"

function createResponse() {
  const res: any = {}
  res.status = mock((code: number) => {
    res.statusCode = code
    return res
  })
  res.json = mock((body: unknown) => {
    res.body = body
    return res
  })
  res.send = mock(() => res)
  return res
}

function buildAttachment(safetyStatus: (typeof AttachmentSafetyStatuses)[keyof typeof AttachmentSafetyStatuses]) {
  return {
    id: "attach_1",
    workspaceId: "ws_1",
    streamId: null,
    messageId: null,
    uploadedBy: "usr_1",
    filename: "test.png",
    mimeType: "image/png",
    sizeBytes: 100,
    storageProvider: "s3",
    storagePath: "ws_1/attach_1/test.png",
    processingStatus: "pending",
    safetyStatus,
    createdAt: new Date(),
  }
}

describe("attachment handlers safety gating", () => {
  // Suite-level cleanup so spies don't leak into later tests if an
  // assertion fails before an inline `mockRestore()` runs.
  afterEach(() => {
    mock.restore()
  })

  it("rejects upload when scanner quarantines the file", async () => {
    const attachmentService = {
      createForUpload: mock(() =>
        Promise.resolve({
          status: "blocked",
          reason: "Attachment is quarantined due to malware scan",
        })
      ),
    } as any

    const streamService = {
      isMember: mock(() => Promise.resolve(true)),
    } as any

    const handlers = createAttachmentHandlers({ attachmentService, streamService, storage: {} as any, pool: {} as any })
    const res = createResponse()

    await handlers.upload(
      {
        user: { id: "usr_1" },
        workspaceId: "ws_1",
        attachmentId: "attach_1",
        file: {
          key: "ws_1/attach_1/test.png",
          originalname: "test.png",
          mimetype: "image/png",
          size: 100,
        },
      } as any,
      res
    )

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.body).toEqual({ error: "Attachment is quarantined due to malware scan" })
  })

  it("returns 500 with attachmentId when quarantined cleanup fails", async () => {
    const attachmentService = {
      createForUpload: mock(() =>
        Promise.resolve({
          status: "cleanup_failed",
          attachmentId: "attach_1",
        })
      ),
    } as any

    const streamService = {
      isMember: mock(() => Promise.resolve(true)),
    } as any

    const handlers = createAttachmentHandlers({ attachmentService, streamService, storage: {} as any, pool: {} as any })
    const res = createResponse()

    await handlers.upload(
      {
        user: { id: "usr_1" },
        workspaceId: "ws_1",
        attachmentId: "attach_1",
        file: {
          key: "ws_1/attach_1/test.png",
          originalname: "test.png",
          mimetype: "image/png",
          size: 100,
        },
      } as any,
      res
    )

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.body).toEqual({
      error: "Attachment quarantined and cleanup failed",
      attachmentId: "attach_1",
    })
  })

  it("forces placeholder metadata and flags e2e when the upload is E2E", async () => {
    const createForUpload = mock(() =>
      Promise.resolve({ status: "created", attachment: buildAttachment(AttachmentSafetyStatuses.E2E_UNSCANNED) })
    )
    const attachmentService = { createForUpload } as any
    const handlers = createAttachmentHandlers({
      attachmentService,
      streamService: {} as any,
      storage: {} as any,
      pool: {} as any,
    })
    const res = createResponse()

    await handlers.upload(
      {
        user: { id: "usr_1" },
        workspaceId: "ws_1",
        attachmentId: "attach_e2e",
        body: { e2e: "true" },
        file: {
          key: "ws_1/attach_e2e/encrypted",
          originalname: "Q3-layoffs.xlsx", // real name must NOT reach the row
          mimetype: "application/vnd.ms-excel",
          size: 2048,
        },
      } as any,
      res
    )

    expect(res.status).toHaveBeenCalledWith(201)
    expect(createForUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        e2e: true,
        filename: "encrypted",
        mimeType: "application/octet-stream",
        sizeBytes: 2048,
      })
    )
  })

  it("keeps real metadata and does not flag e2e for a normal upload", async () => {
    const createForUpload = mock(() =>
      Promise.resolve({ status: "created", attachment: buildAttachment(AttachmentSafetyStatuses.CLEAN) })
    )
    const attachmentService = { createForUpload } as any
    const handlers = createAttachmentHandlers({
      attachmentService,
      streamService: {} as any,
      storage: {} as any,
      pool: {} as any,
    })
    const res = createResponse()

    await handlers.upload(
      {
        user: { id: "usr_1" },
        workspaceId: "ws_1",
        attachmentId: "attach_1",
        body: {},
        file: { key: "ws_1/attach_1/photo.png", originalname: "photo.png", mimetype: "image/png", size: 100 },
      } as any,
      res
    )

    expect(res.status).toHaveBeenCalledWith(201)
    expect(createForUpload).toHaveBeenCalledWith(
      expect.objectContaining({ e2e: false, filename: "photo.png", mimeType: "image/png" })
    )
  })

  it("blocks download URL while malware scan is pending", async () => {
    const attachmentService = {
      getById: mock(() => Promise.resolve(buildAttachment(AttachmentSafetyStatuses.PENDING_SCAN))),
      getDownloadUrl: mock(() => Promise.resolve("https://download")),
      getSharingBlockReason: mock(() => "Attachment is pending malware scan"),
    } as any

    const streamService = {
      isMember: mock(() => Promise.resolve(true)),
    } as any

    const handlers = createAttachmentHandlers({ attachmentService, streamService, storage: {} as any, pool: {} as any })
    const res = createResponse()

    await handlers.getDownloadUrl(
      {
        user: { id: "usr_1" },
        workspaceId: "ws_1",
        params: { attachmentId: "attach_1" },
        query: {},
      } as any,
      res
    )

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.body).toEqual({ error: "Attachment is pending malware scan" })
    expect(attachmentService.getDownloadUrl).not.toHaveBeenCalled()
  })

  it("blocks download URL for quarantined attachments", async () => {
    const attachmentService = {
      getById: mock(() => Promise.resolve(buildAttachment(AttachmentSafetyStatuses.QUARANTINED))),
      getDownloadUrl: mock(() => Promise.resolve("https://download")),
      getSharingBlockReason: mock(() => "Attachment is quarantined due to malware scan"),
    } as any

    const streamService = {
      isMember: mock(() => Promise.resolve(true)),
    } as any

    const handlers = createAttachmentHandlers({ attachmentService, streamService, storage: {} as any, pool: {} as any })
    const res = createResponse()

    await handlers.getDownloadUrl(
      {
        user: { id: "usr_1" },
        workspaceId: "ws_1",
        params: { attachmentId: "attach_1" },
        query: {},
      } as any,
      res
    )

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.body).toEqual({ error: "Attachment is quarantined due to malware scan" })
    expect(attachmentService.getDownloadUrl).not.toHaveBeenCalled()
  })

  it("returns download URL for clean attachments", async () => {
    const attachmentService = {
      getById: mock(() => Promise.resolve(buildAttachment(AttachmentSafetyStatuses.CLEAN))),
      getDownloadUrl: mock(() => Promise.resolve("https://download")),
      getSharingBlockReason: mock(() => null),
    } as any

    const streamService = {
      isMember: mock(() => Promise.resolve(true)),
    } as any

    const handlers = createAttachmentHandlers({ attachmentService, streamService, storage: {} as any, pool: {} as any })
    const res = createResponse()

    await handlers.getDownloadUrl(
      {
        user: { id: "usr_1" },
        workspaceId: "ws_1",
        params: { attachmentId: "attach_1" },
        query: {},
      } as any,
      res
    )

    expect(attachmentService.getDownloadUrl).toHaveBeenCalled()
    expect(res.body).toEqual({ url: "https://download", expiresIn: 900 })
  })

  it("denies download when user has no direct stream access nor share grant nor inline reference", async () => {
    const attachment = {
      ...buildAttachment(AttachmentSafetyStatuses.CLEAN),
      streamId: "str_source",
      messageId: "msg_source",
    }
    const attachmentService = {
      getById: mock(() => Promise.resolve(attachment)),
      getDownloadUrl: mock(() => Promise.resolve("https://download")),
      getSharingBlockReason: mock(() => null),
    } as any
    const streamService = {
      tryAccess: mock(() => Promise.resolve(null)),
    } as any
    const grantSpy = spyOn(SharedMessageRepository, "listSourcesGrantedToViewer").mockResolvedValue(new Set())
    const refSpy = spyOn(AttachmentReferenceRepository, "hasViewerAccessByReference").mockResolvedValue(false)

    const handlers = createAttachmentHandlers({ attachmentService, streamService, storage: {} as any, pool: {} as any })
    const res = createResponse()

    await handlers.getDownloadUrl(
      {
        user: { id: "usr_1" },
        workspaceId: "ws_1",
        params: { attachmentId: "attach_1" },
        query: {},
      } as any,
      res
    )

    expect(grantSpy).toHaveBeenCalled()
    expect(refSpy).toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.body).toEqual({ error: "Access denied" })
    expect(attachmentService.getDownloadUrl).not.toHaveBeenCalled()
  })

  it("returns download URL when access is granted via an inline attachment reference", async () => {
    const attachment = {
      ...buildAttachment(AttachmentSafetyStatuses.CLEAN),
      streamId: "str_source",
      messageId: "msg_source",
    }
    const attachmentService = {
      getById: mock(() => Promise.resolve(attachment)),
      getDownloadUrl: mock(() => Promise.resolve("https://download")),
      getSharingBlockReason: mock(() => null),
    } as any
    const streamService = {
      tryAccess: mock(() => Promise.resolve(null)),
    } as any
    const grantSpy = spyOn(SharedMessageRepository, "listSourcesGrantedToViewer").mockResolvedValue(new Set())
    const refSpy = spyOn(AttachmentReferenceRepository, "hasViewerAccessByReference").mockResolvedValue(true)

    const handlers = createAttachmentHandlers({ attachmentService, streamService, storage: {} as any, pool: {} as any })
    const res = createResponse()

    await handlers.getDownloadUrl(
      {
        user: { id: "usr_1" },
        workspaceId: "ws_1",
        params: { attachmentId: "attach_1" },
        query: {},
      } as any,
      res
    )

    expect(refSpy).toHaveBeenCalledWith(expect.anything(), "ws_1", "usr_1", "attach_1")
    expect(attachmentService.getDownloadUrl).toHaveBeenCalled()
    expect(res.body).toEqual({ url: "https://download", expiresIn: 900 })
  })

  it("returns download URL when access is granted via a shared-message", async () => {
    const attachment = {
      ...buildAttachment(AttachmentSafetyStatuses.CLEAN),
      streamId: "str_source",
      messageId: "msg_source",
    }
    const attachmentService = {
      getById: mock(() => Promise.resolve(attachment)),
      getDownloadUrl: mock(() => Promise.resolve("https://download")),
      getSharingBlockReason: mock(() => null),
    } as any
    const streamService = {
      tryAccess: mock(() => Promise.resolve(null)),
    } as any
    const grantSpy = spyOn(SharedMessageRepository, "listSourcesGrantedToViewer").mockResolvedValue(
      new Set(["msg_source"])
    )

    const handlers = createAttachmentHandlers({ attachmentService, streamService, storage: {} as any, pool: {} as any })
    const res = createResponse()

    await handlers.getDownloadUrl(
      {
        user: { id: "usr_1" },
        workspaceId: "ws_1",
        params: { attachmentId: "attach_1" },
        query: {},
      } as any,
      res
    )

    expect(grantSpy).toHaveBeenCalled()
    expect(attachmentService.getDownloadUrl).toHaveBeenCalled()
    expect(res.body).toEqual({ url: "https://download", expiresIn: 900 })
  })
})

function buildSearchRow(overrides: Partial<AttachmentSearchRow> = {}): AttachmentSearchRow {
  const createdAt = overrides.createdAt ?? new Date("2026-05-01T10:00:00.000Z")
  return {
    id: "attach_a",
    workspaceId: "ws_1",
    streamId: "str_design",
    messageId: "msg_1",
    uploadedBy: "usr_1",
    filename: "logo.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    storageProvider: "s3",
    storagePath: "ws_1/attach_a/logo.png",
    processingStatus: "completed",
    safetyStatus: AttachmentSafetyStatuses.CLEAN,
    e2eOnly: false,
    thumbnailStoragePath: null,
    width: null,
    height: null,
    createdAt,
    extraction: null,
    streamSlug: "design",
    streamName: "Design",
    streamType: "channel",
    uploaderSlug: "mira",
    uploaderName: "Mira",
    referenceCount: 0,
    ...overrides,
  }
}

describe("attachment search handler", () => {
  afterEach(() => {
    mock.restore()
  })

  function makeHandlers() {
    const attachmentService = {} as any
    const streamService = {} as any
    return createAttachmentHandlers({ attachmentService, streamService, storage: {} as any, pool: {} as any })
  }

  it("rejects unknown body fields via strict zod schema", async () => {
    const handlers = makeHandlers()
    const res = createResponse()

    await handlers.search(
      {
        user: { id: "usr_1" },
        workspaceId: "ws_1",
        body: { somethingExtra: true },
      } as any,
      res
    )

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.body).toMatchObject({ error: "Invalid request body" })
  })

  it("rejects an invalid base64 cursor", async () => {
    const handlers = makeHandlers()
    const res = createResponse()

    await handlers.search(
      {
        user: { id: "usr_1" },
        workspaceId: "ws_1",
        body: { cursor: "!!!not-base64!!!" },
      } as any,
      res
    )

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.body).toEqual({ error: "Invalid cursor" })
  })

  it("forwards filters and identity to the repository", async () => {
    const searchSpy = spyOn(AttachmentRepository, "search").mockResolvedValue([])
    const handlers = makeHandlers()
    const res = createResponse()

    await handlers.search(
      {
        user: { id: "usr_1" },
        workspaceId: "ws_1",
        body: {
          streamIds: ["str_design"],
          categories: ["image", "pdf"],
          uploadedBy: "usr_2",
          before: "2026-05-01T00:00:00.000Z",
          after: "2026-04-01T00:00:00.000Z",
          queryText: "invoice",
          exact: true,
          nameSubstring: "q2",
          limit: 25,
        },
      } as any,
      res
    )

    expect(searchSpy).toHaveBeenCalledTimes(1)
    const args = searchSpy.mock.calls[0]![1]
    expect(args).toMatchObject({
      workspaceId: "ws_1",
      userId: "usr_1",
      streamIds: ["str_design"],
      categories: ["image", "pdf"],
      uploadedBy: "usr_2",
      queryText: "invoice",
      exact: true,
      nameSubstring: "q2",
      limit: 25,
    })
    expect(args.before).toEqual(new Date("2026-05-01T00:00:00.000Z"))
    expect(args.after).toEqual(new Date("2026-04-01T00:00:00.000Z"))
  })

  it("returns null nextCursor when fewer than limit+1 rows come back", async () => {
    const rows = [buildSearchRow({ id: "attach_a" }), buildSearchRow({ id: "attach_b" })]
    spyOn(AttachmentRepository, "search").mockResolvedValue(rows)

    const handlers = makeHandlers()
    const res = createResponse()

    await handlers.search(
      {
        user: { id: "usr_1" },
        workspaceId: "ws_1",
        body: { limit: 30 },
      } as any,
      res
    )

    expect(res.body.items).toHaveLength(2)
    expect(res.body.nextCursor).toBeNull()
    expect(res.body.items[0]).toMatchObject({
      id: "attach_a",
      filename: "logo.png",
      streamSlug: "design",
      uploaderSlug: "mira",
      referenceCount: 0,
    })
  })

  it("trims the trailing row and emits a base64url cursor when more pages exist", async () => {
    const t0 = new Date("2026-05-01T12:00:00.000Z")
    const t1 = new Date("2026-05-01T11:00:00.000Z")
    const t2 = new Date("2026-05-01T10:00:00.000Z")
    spyOn(AttachmentRepository, "search").mockResolvedValue([
      buildSearchRow({ id: "attach_a", createdAt: t0 }),
      buildSearchRow({ id: "attach_b", createdAt: t1 }),
      buildSearchRow({ id: "attach_c", createdAt: t2 }),
    ])

    const handlers = makeHandlers()
    const res = createResponse()

    await handlers.search(
      {
        user: { id: "usr_1" },
        workspaceId: "ws_1",
        body: { limit: 2 },
      } as any,
      res
    )

    expect(res.body.items).toHaveLength(2)
    expect(res.body.items.map((row: any) => row.id)).toEqual(["attach_a", "attach_b"])

    expect(typeof res.body.nextCursor).toBe("string")
    const decoded = JSON.parse(Buffer.from(res.body.nextCursor, "base64url").toString("utf8"))
    expect(decoded).toEqual({ c: t1.toISOString(), i: "attach_b" })
  })

  it("decodes a previously-emitted cursor and forwards it to the repository", async () => {
    const t = new Date("2026-05-01T11:00:00.000Z")
    const cursor = Buffer.from(JSON.stringify({ c: t.toISOString(), i: "attach_b" }), "utf8").toString("base64url")
    const searchSpy = spyOn(AttachmentRepository, "search").mockResolvedValue([])

    const handlers = makeHandlers()
    const res = createResponse()

    await handlers.search(
      {
        user: { id: "usr_1" },
        workspaceId: "ws_1",
        body: { cursor },
      } as any,
      res
    )

    const args = searchSpy.mock.calls[0]![1]
    expect(args.cursor).toEqual({ createdAt: t, id: "attach_b" })
  })

  it("serializes extraction excerpts when present", async () => {
    spyOn(AttachmentRepository, "search").mockResolvedValue([
      buildSearchRow({
        id: "attach_pdf",
        filename: "Q2.pdf",
        mimeType: "application/pdf",
        extraction: {
          contentType: "document",
          summary: "Quarterly summary",
        },
        referenceCount: 3,
      }),
    ])

    const handlers = makeHandlers()
    const res = createResponse()

    await handlers.search(
      {
        user: { id: "usr_1" },
        workspaceId: "ws_1",
        body: {},
      } as any,
      res
    )

    expect(res.body.items[0]).toMatchObject({
      id: "attach_pdf",
      filename: "Q2.pdf",
      extraction: { contentType: "document", summary: "Quarterly summary" },
      referenceCount: 3,
    })
    expect(res.body.items[0].extraction).not.toHaveProperty("fullText")
  })
})

/**
 * Response double for the streaming content handler: a real Writable so
 * `stream.pipe(res)` works, with the Express helpers the handler touches.
 */
function createStreamingResponse() {
  const chunks: Buffer[] = []
  const res: any = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  res.statusCode = 200
  res.headers = {} as Record<string, string>
  res.set = mock((name: string, value: string) => {
    res.headers[name.toLowerCase()] = value
    return res
  })
  res.status = mock((code: number) => {
    res.statusCode = code
    return res
  })
  res.json = mock((body: unknown) => {
    res.body = body
    return res
  })
  res.sentBytes = () => Buffer.concat(chunks)
  return res
}

function pathEtag(storagePath: string): string {
  return `"${createHash("sha256").update(storagePath).digest("hex")}"`
}

function buildContentStorage(content = "image-bytes") {
  return {
    getObjectContent: mock(async (_key: string, options?: { range?: string }) => ({
      stream: Readable.from([Buffer.from(content)]),
      contentLength: content.length,
      contentRange: options?.range ? `bytes 0-${content.length - 1}/${content.length}` : undefined,
    })),
  } as any
}

function contentRequest(overrides: Record<string, unknown> = {}) {
  return {
    user: { id: "usr_1" },
    workspaceId: "ws_1",
    params: { attachmentId: "attach_1" },
    query: {},
    headers: {},
    ...overrides,
  } as any
}

describe("attachment content handler", () => {
  afterEach(() => {
    mock.restore()
  })

  function makeHandlers({
    attachment = buildAttachment(AttachmentSafetyStatuses.CLEAN),
    storage = buildContentStorage(),
    streamService = { tryAccess: mock(() => Promise.resolve({ id: "str_1" })) } as any,
  }: { attachment?: any; storage?: any; streamService?: any } = {}) {
    const attachmentService = {
      getById: mock(() => Promise.resolve(attachment)),
      getSharingBlockReason: mock(() => null),
    } as any
    return {
      handlers: createAttachmentHandlers({ attachmentService, streamService, storage, pool: {} as any }),
      storage,
    }
  }

  it("streams the raw object with immutable caching and document-execution hardening", async () => {
    const attachment = buildAttachment(AttachmentSafetyStatuses.CLEAN)
    const { handlers, storage } = makeHandlers({ attachment })
    const res = createStreamingResponse()

    await handlers.getContent(contentRequest(), res)
    await once(res, "finish")

    expect(storage.getObjectContent).toHaveBeenCalledWith("ws_1/attach_1/test.png", { range: undefined })
    expect(res.sentBytes().toString()).toBe("image-bytes")
    expect(res.headers).toMatchObject({
      "content-type": "image/png",
      "cache-control": "private, max-age=31536000, immutable",
      etag: pathEtag("ws_1/attach_1/test.png"),
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "accept-ranges": "bytes",
      "content-length": "11",
    })
  })

  it("returns 304 without fetching the object when If-None-Match matches", async () => {
    const { handlers, storage } = makeHandlers()
    const res = createStreamingResponse()

    await handlers.getContent(contentRequest({ headers: { "if-none-match": pathEtag("ws_1/attach_1/test.png") } }), res)

    expect(res.statusCode).toBe(304)
    expect(storage.getObjectContent).not.toHaveBeenCalled()
  })

  it("serves the sharp thumbnail variant as webp when generated", async () => {
    const attachment = {
      ...buildAttachment(AttachmentSafetyStatuses.CLEAN),
      thumbnailStoragePath: "ws_1/attach_1/thumbnail.webp",
    }
    const { handlers, storage } = makeHandlers({ attachment })
    const res = createStreamingResponse()

    await handlers.getContent(contentRequest({ query: { variant: "thumbnail" } }), res)
    await once(res, "finish")

    expect(storage.getObjectContent).toHaveBeenCalledWith("ws_1/attach_1/thumbnail.webp", { range: undefined })
    expect(res.headers).toMatchObject({
      "content-type": "image/webp",
      "cache-control": "private, max-age=31536000, immutable",
      etag: pathEtag("ws_1/attach_1/thumbnail.webp"),
    })
  })

  it("serves the raw fall-through with no-store and no ETag while the thumbnail is not ready", async () => {
    // Caching the fallback under the variant URL would pin the raw bytes
    // forever ("immutable") and the real thumbnail would never appear.
    const { handlers, storage } = makeHandlers()
    const res = createStreamingResponse()

    await handlers.getContent(contentRequest({ query: { variant: "thumbnail" } }), res)
    await once(res, "finish")

    expect(storage.getObjectContent).toHaveBeenCalledWith("ws_1/attach_1/test.png", { range: undefined })
    expect(res.headers["cache-control"]).toBe("private, no-store")
    expect(res.headers).not.toHaveProperty("etag")
  })

  it("serves the processed video variant from the completed transcode job", async () => {
    const attachment = {
      ...buildAttachment(AttachmentSafetyStatuses.CLEAN),
      mimeType: "video/quicktime",
      filename: "clip.mov",
      storagePath: "ws_1/attach_1/clip.mov",
    }
    spyOn(VideoTranscodeJobRepository, "findByAttachmentId").mockResolvedValue({
      status: "completed",
      processedStoragePath: "ws_1/attach_1/processed.mp4",
      thumbnailStoragePath: "ws_1/attach_1/thumbnail.0000000.jpg",
    } as any)
    const { handlers, storage } = makeHandlers({ attachment })
    const res = createStreamingResponse()

    await handlers.getContent(contentRequest({ query: { variant: "processed" } }), res)
    await once(res, "finish")

    expect(storage.getObjectContent).toHaveBeenCalledWith("ws_1/attach_1/processed.mp4", { range: undefined })
    expect(res.headers).toMatchObject({
      "content-type": "video/mp4",
      "cache-control": "private, max-age=31536000, immutable",
    })
  })

  it("falls through to the raw video with no-store while the transcode is incomplete", async () => {
    const attachment = {
      ...buildAttachment(AttachmentSafetyStatuses.CLEAN),
      mimeType: "video/quicktime",
      filename: "clip.mov",
      storagePath: "ws_1/attach_1/clip.mov",
    }
    spyOn(VideoTranscodeJobRepository, "findByAttachmentId").mockResolvedValue({
      status: "submitted",
      processedStoragePath: null,
      thumbnailStoragePath: null,
    } as any)
    const { handlers, storage } = makeHandlers({ attachment })
    const res = createStreamingResponse()

    await handlers.getContent(contentRequest({ query: { variant: "processed" } }), res)
    await once(res, "finish")

    expect(storage.getObjectContent).toHaveBeenCalledWith("ws_1/attach_1/clip.mov", { range: undefined })
    expect(res.headers["cache-control"]).toBe("private, no-store")
    expect(res.headers["content-type"]).toBe("video/quicktime")
  })

  it("passes a Range request through and responds 206 with Content-Range", async () => {
    const { handlers, storage } = makeHandlers()
    const res = createStreamingResponse()

    await handlers.getContent(contentRequest({ headers: { range: "bytes=0-10" } }), res)
    await once(res, "finish")

    expect(storage.getObjectContent).toHaveBeenCalledWith("ws_1/attach_1/test.png", { range: "bytes=0-10" })
    expect(res.statusCode).toBe(206)
    expect(res.headers["content-range"]).toBe("bytes 0-10/11")
  })

  it("returns 404 for an attachment in another workspace", async () => {
    const attachment = { ...buildAttachment(AttachmentSafetyStatuses.CLEAN), workspaceId: "ws_other" }
    const { handlers, storage } = makeHandlers({ attachment })
    const res = createStreamingResponse()

    await handlers.getContent(contentRequest(), res)

    expect(res.statusCode).toBe(404)
    expect(storage.getObjectContent).not.toHaveBeenCalled()
  })

  it("blocks content while the malware scan is pending", async () => {
    const attachmentService = {
      getById: mock(() => Promise.resolve(buildAttachment(AttachmentSafetyStatuses.PENDING_SCAN))),
      getSharingBlockReason: mock(() => "Attachment is pending malware scan"),
    } as any
    const storage = buildContentStorage()
    const handlers = createAttachmentHandlers({
      attachmentService,
      streamService: {} as any,
      storage,
      pool: {} as any,
    })
    const res = createStreamingResponse()

    await handlers.getContent(contentRequest(), res)

    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ error: "Attachment is pending malware scan" })
    expect(storage.getObjectContent).not.toHaveBeenCalled()
  })

  it("denies content when there is no stream access, share grant, or inline reference", async () => {
    const attachment = {
      ...buildAttachment(AttachmentSafetyStatuses.CLEAN),
      streamId: "str_source",
      messageId: "msg_source",
    }
    spyOn(SharedMessageRepository, "listSourcesGrantedToViewer").mockResolvedValue(new Set())
    spyOn(AttachmentReferenceRepository, "hasViewerAccessByReference").mockResolvedValue(false)
    const { handlers, storage } = makeHandlers({
      attachment,
      streamService: { tryAccess: mock(() => Promise.resolve(null)) } as any,
    })
    const res = createStreamingResponse()

    await handlers.getContent(contentRequest(), res)

    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ error: "Access denied" })
    expect(storage.getObjectContent).not.toHaveBeenCalled()
  })

  it("serves E2E ciphertext with its placeholder mime type", async () => {
    const attachment = {
      ...buildAttachment(AttachmentSafetyStatuses.E2E_UNSCANNED),
      filename: "encrypted",
      mimeType: "application/octet-stream",
      storagePath: "ws_1/attach_1/encrypted",
    }
    const { handlers, storage } = makeHandlers({ attachment })
    const res = createStreamingResponse()

    await handlers.getContent(contentRequest(), res)
    await once(res, "finish")

    expect(storage.getObjectContent).toHaveBeenCalledWith("ws_1/attach_1/encrypted", { range: undefined })
    expect(res.headers).toMatchObject({
      "content-type": "application/octet-stream",
      "cache-control": "private, max-age=31536000, immutable",
    })
  })

  it("rejects an unknown variant", async () => {
    const { handlers, storage } = makeHandlers()
    const res = createStreamingResponse()

    await handlers.getContent(contentRequest({ query: { variant: "original" } }), res)

    expect(res.statusCode).toBe(400)
    expect(storage.getObjectContent).not.toHaveBeenCalled()
  })
})
